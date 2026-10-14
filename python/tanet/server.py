"""TA network training server for research/taNetTorch.ts: JSON lines on stdin, one JSON reply line per request on
stdout (logs go to stderr). Started once per ta_net pipeline step; holds the training pack on the GPU.

Requests:
  init      {pack, dims, layout, plans, norm, device: auto|cpu|cuda, dtype: float32|float64, graphs: CUDA graphs (default on),
             resident: tables copied into memory on the CPU too (always on the GPU)}
  train     {w, m, v (base64 float64), step, hyper, idx (base64 int32), seed, epochs, batch}
            -> {w, m, v, step, loss, secs, samples, graph}: mini-batch AdamW epochs, exactly research/trainTaNet.ts
            trainEpoch's update
  forecast  {w, gates [5], idx} -> {out: base64 float32, n x 3 raw outputs (logits up 1h / 4h, vol)}
  forward   {w, x: {micro, swing, trend, macro, ctx} base64 float64 batches, b, scale, mmask?, smask?} (tests)
  grad      forward's fields + y, volWeight -> {grad, loss} (tests)
  quit
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
import traceback

import numpy as np
import torch

from net import TaNet, loss_of


def b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode('ascii')


def unb64(s: str, dtype) -> np.ndarray:
    return np.frombuffer(base64.b64decode(s), dtype=dtype)


def log(m: str) -> None:
    print(f'[tanet-torch] {m}', file=sys.stderr, flush=True)


class State:
    net: TaNet
    dev: torch.device
    dt: torch.dtype
    tables: dict
    meta: dict


S = State()


def normalise(t: torch.Tensor, m: torch.Tensor, s: torch.Tensor) -> torch.Tensor:
    """research/trainTaNet.ts buildBranchInput: clamp((v - mean) / std, +-8), missing -> 0."""
    z = torch.clamp((t - m) / s, -8, 8)
    return torch.where(torch.isfinite(t), z, torch.zeros_like(z))


def load_table(name: str, path: str, cols: int, mean=None, std=None, dtype=np.float32, chunk_rows=200_000) -> torch.Tensor:
    """A pack file as a (rows, cols) tensor. GPU: copied to the device and normalised there, chunk by chunk. CPU:
    left memory-mapped (the OS pages it in; host memory stays small) and normalised as batches are gathered."""
    is_f = dtype == np.float32
    if mean is not None:
        S.norms[name] = (torch.tensor(mean, dtype=S.dt, device=S.dev), torch.tensor(std, dtype=S.dt, device=S.dev))
    if os.path.getsize(path) == 0:
        return torch.empty((0, cols), dtype=S.dt if is_f else torch.int64, device=S.dev)
    mm = np.memmap(path, dtype=dtype, mode='c')
    rows = mm.shape[0] // cols
    mm = mm.reshape(rows, cols)
    if S.dev.type == 'cpu' and not S.resident:
        return torch.from_numpy(mm)
    out = torch.empty((rows, cols), dtype=S.dt if is_f else torch.int64, device=S.dev)
    for a in range(0, rows, chunk_rows):
        b = min(rows, a + chunk_rows)
        c = torch.from_numpy(np.array(mm[a:b])).to(S.dev)
        c = c.to(S.dt if is_f else torch.int64)
        if name in S.norms:
            c = normalise(c, *S.norms[name])
        out[a:b] = c
    S.norms.pop(name, None)  # already applied
    return out


def init(req: dict) -> dict:
    try:
        return setup(req)
    except torch.cuda.OutOfMemoryError:
        if req.get('device', 'auto') != 'auto':
            raise
        # The pack does not fit in the GPU's memory: the CPU, with the tables memory-mapped.
        S.tables = {}
        torch.cuda.empty_cache()
        log('the training pack does not fit in GPU memory; training on the CPU')
        return setup({**req, 'device': 'cpu', 'resident': False})


def setup(req: dict) -> dict:
    want = req.get('device', 'auto')
    S.dev = torch.device('cuda' if (want in ('auto', 'cuda') and torch.cuda.is_available()) else 'cpu')
    if S.dev.type == 'cuda':
        try:  # the build has kernels for this GPU (an RTX 50xx needs a CUDA 12.8 build)
            assert float((torch.ones(8, device=S.dev) * 2).sum()) == 16.0
        except Exception as e:  # noqa: BLE001
            if want == 'cuda':
                raise
            log(f'the GPU does not run this PyTorch build ({str(e).splitlines()[0][:160]}); using the CPU')
            S.dev = torch.device('cpu')
    # Full float32 (no TF32 shortcuts in convolutions / matmuls): forecasts stay close to the TypeScript network's.
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cuda.matmul.allow_tf32 = False
    S.dt = torch.float64 if req.get('dtype') == 'float64' else torch.float32
    if S.dev.type == 'cpu':
        torch.set_num_threads(max(1, int(req.get('threads') or os.cpu_count() or 1)))
    S.net = TaNet(req['dims'], req['layout'], req['plans'], S.dev, S.dt)
    S.W = torch.zeros(S.net.size, dtype=S.dt, device=S.dev, requires_grad=True)
    S.m = torch.zeros(S.net.size, dtype=S.dt, device=S.dev)
    S.v = torch.zeros(S.net.size, dtype=S.dt, device=S.dev)
    S.loss = torch.zeros((), dtype=S.dt, device=S.dev)
    S.hp = {k: torch.zeros((), dtype=S.dt, device=S.dev) for k in ('lr', 'wd', 'volw', 'c1', 'c2')}
    S.graphs = 'emulate' if req.get('graphs') == 'emulate' else req.get('graphs', True) is not False
    S.graph_for = {}
    S.norms = {}
    S.resident = S.dev.type == 'cuda' or bool(req.get('resident'))  # tables in device memory, normalised once
    S.tables = {}
    S.meta = {}
    pack = req.get('pack')
    if pack:
        t0 = time.time()
        meta = json.load(open(os.path.join(pack, 'meta.json')))
        S.meta = meta
        nm = req['norm']
        cI = meta['cI']
        f = lambda name: os.path.join(pack, name)
        S.tables = {
            'trend': load_table('trend', f('rows_trend.f32'), meta['tF'], nm['trend']['mean'], nm['trend']['std']),
            'ctxr': load_table('ctxr', f('rows_ctx.f32'), cI, nm['ctx']['mean'][:cI], nm['ctx']['std'][:cI]),
            'dvec': load_table('dvec', f('days_vec.f32'), meta['dF'], nm['macro']['mean'], nm['macro']['std']),
            'ddom': load_table('ddom', f('days_dom.f32'), meta['nDom'], nm['ctx']['mean'][cI:], nm['ctx']['std'][cI:]),
            'micro': load_table('micro', f('s_micro.f32'), meta['mT'] * meta['mF'], nm['micro']['mean'] * meta['mT'], nm['micro']['std'] * meta['mT']),
            'swing': load_table('swing', f('s_swing.f32'), meta['sT'] * meta['sF'], nm['swing']['mean'] * meta['sT'], nm['swing']['std'] * meta['sT']),
            'y': load_table('y', f('s_y.f32'), 3),
            'gr': load_table('gr', f('s_gr.i32'), 1, dtype=np.int32).view(-1),
            'gd': load_table('gd', f('s_gd.i32'), 1, dtype=np.int32).view(-1),
        }
        if meta['cI'] + meta['nDom'] != req['dims']['cF']:
            raise ValueError(f"pack context width {meta['cI']} + {meta['nDom']} != network cF {req['dims']['cF']}")
        S.tw = torch.arange(-meta['tT'] + 1, 1, device=S.dev)
        S.dw = torch.arange(-meta['dT'] + 1, 1, device=S.dev)
        log(f"pack loaded on {S.dev}: {meta['n']} samples in {time.time() - t0:.1f} s")
    name = torch.cuda.get_device_name(0) if S.dev.type == 'cuda' else 'cpu'
    return {'device': S.dev.type, 'name': name, 'n': S.meta.get('n', 0), 'torch': torch.__version__}


def batch_inputs(ids: torch.Tensor) -> dict:
    T, d = S.tables, S.meta

    def g(name: str, x: torch.Tensor) -> torch.Tensor:
        x = x.to(S.dt)
        n = S.norms.get(name)
        return x if n is None else normalise(x, *n)

    gr, gd = T['gr'][ids].long(), T['gd'][ids].long()
    return {
        'trend': g('trend', T['trend'][gr.unsqueeze(1) + S.tw]),
        'macro': g('dvec', T['dvec'][gd.unsqueeze(1) + S.dw]),
        'ctx': torch.cat([g('ctxr', T['ctxr'][gr]), g('ddom', T['ddom'][gd])], dim=1),
        'micro': g('micro', T['micro'][ids]).view(-1, d['mT'], d['mF']),
        'swing': g('swing', T['swing'][ids]).view(-1, d['sT'], d['sF']),
    }


def targets(ids: torch.Tensor) -> torch.Tensor:
    return S.tables['y'][ids].to(S.dt)


def gates_of(h: dict) -> list:
    return [h.get('gMicro', 1), h.get('gSwing', 1), h.get('gTrend', 1), h.get('gMacro', 1), h.get('gCtx', 1)]


# ---- training ---------------------------------------------------------------------------------------------------
# One member at a time: its weights and AdamW moments are copied into the persistent device tensors S.W / S.m / S.v,
# trained, and sent back. On a GPU the whole step (gather, forward, backward, AdamW) is recorded once as a CUDA graph
# and replayed per batch: a few launches instead of hundreds (eager PyTorch at batch 64 waits on Python, not on the
# GPU). The graph is checked against the eager step before it is used; any problem -> eager.

def train_step(ids: torch.Tensor, scale: torch.Tensor, mm: torch.Tensor, sm: torch.Tensor, B: int) -> None:
    """One mini-batch AdamW step on S.W / S.m / S.v (exactly research/trainTaNet.ts trainEpoch's update)."""
    hp = S.hp
    x = batch_inputs(ids)
    out = S.net.forward(S.W, x, scale, mm, sm)
    loss = loss_of(out, targets(ids), hp['volw'])
    gW, = torch.autograd.grad(loss / B, S.W)
    with torch.no_grad():
        S.m.mul_(0.9).add_(gW, alpha=0.1)
        S.v.mul_(0.999).addcmul_(gW, gW, value=0.001)
        S.W.sub_(hp['lr'] * ((S.m / hp['c1']) / (torch.sqrt(S.v / hp['c2']) + 1e-8) + hp['wd'] * S.net.decay_mask * S.W))
        S.loss.add_(loss.detach())


class Graphed:
    """train_step at a fixed batch size B as a CUDA graph over static input buffers."""

    def __init__(self, B: int):
        net, dev, dt = S.net, S.dev, S.dt
        self.B = B
        self.ids = torch.zeros(B, dtype=torch.int64, device=dev)
        self.scale = torch.ones(B, 5, dtype=dt, device=dev)
        self.mm = torch.ones(B, net.micro.joins, 2, dtype=dt, device=dev)
        self.sm = torch.ones(B, net.swing.joins, 2, dtype=dt, device=dev)
        keep = snapshot()
        if S.dev.type != 'cuda':  # tests: the same buffers and replays without a GPU (graphs: 'emulate')
            self.graph = Emulated(lambda: train_step(self.ids, self.scale, self.mm, self.sm, B))
            return
        side = torch.cuda.Stream()
        side.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(side):
            for _ in range(3):
                train_step(self.ids, self.scale, self.mm, self.sm, B)
        torch.cuda.current_stream().wait_stream(side)
        self.graph = torch.cuda.CUDAGraph()
        with torch.cuda.graph(self.graph):
            train_step(self.ids, self.scale, self.mm, self.sm, B)
        restore(keep)

    def step(self, ids, scale, mm, sm) -> None:
        self.ids.copy_(ids)
        self.scale.copy_(scale)
        self.mm.copy_(mm)
        self.sm.copy_(sm)
        self.graph.replay()


class Emulated:
    """Stands in for a CUDA graph in tests: replay = the recorded step on the static buffers."""

    def __init__(self, fn):
        self.fn = fn

    def replay(self) -> None:
        self.fn()


def snapshot() -> tuple:
    return S.W.detach().clone(), S.m.clone(), S.v.clone(), S.loss.clone()


def restore(k: tuple) -> None:
    with torch.no_grad():
        S.W.copy_(k[0]); S.m.copy_(k[1]); S.v.copy_(k[2]); S.loss.copy_(k[3])


def graphed(B: int):
    """The CUDA graph for batch size B, built and checked against the eager step on first use; None -> eager."""
    if not S.graphs or (S.dev.type != 'cuda' and S.graphs != 'emulate'):
        return None
    if B in S.graph_for:
        return S.graph_for[B]
    G = None
    S.hp['c1'].fill_(0.1)  # bias corrections of a step past the first (finite while warming up and checking)
    S.hp['c2'].fill_(0.001)
    try:
        g = Graphed(B)
        n = S.meta.get('n', 0)
        ids = torch.arange(B, device=S.dev) % max(1, n)
        scale = torch.ones(B, 5, dtype=S.dt, device=S.dev)
        mm, sm = torch.ones_like(g.mm), torch.ones_like(g.sm)
        keep = snapshot()
        train_step(ids, scale, mm, sm, B)
        eager_m, eager_loss = S.m.clone(), float(S.loss - keep[3])
        restore(keep)
        g.step(ids, scale, mm, sm)
        graph_m, graph_loss = S.m.clone(), float(S.loss - keep[3])
        restore(keep)
        dm = float((graph_m - eager_m).abs().max())
        tol = 1e-4 * float(eager_m.abs().max()) + 1e-9
        if not (abs(graph_loss - eager_loss) <= 1e-4 * max(1.0, abs(eager_loss)) and dm <= tol):
            log(f'CUDA graph differs from the eager step (loss {graph_loss} vs {eager_loss}, moment diff {dm:.3g}); training eagerly')
        else:
            G = g
            log(f'CUDA graph ready for batch {B}')
    except Exception as e:  # noqa: BLE001
        log(f'CUDA graph unavailable ({type(e).__name__}: {e}); training eagerly')
        if S.dev.type == 'cuda':
            torch.cuda.synchronize()
    S.graph_for[B] = G
    return G


def train(req: dict) -> dict:
    net = S.net
    with torch.no_grad():
        S.W.copy_(torch.from_numpy(unb64(req['w'], np.float64).copy()).to(S.dev, S.dt))
        S.m.copy_(torch.from_numpy(unb64(req['m'], np.float64).copy()).to(S.dev, S.dt))
        S.v.copy_(torch.from_numpy(unb64(req['v'], np.float64).copy()).to(S.dev, S.dt))
    S.loss.zero_()
    step = int(req['step'])
    h = req['hyper']
    S.hp['lr'].fill_(float(h['lr']))
    S.hp['wd'].fill_(float(h.get('wd') or 0))
    S.hp['volw'].fill_(float(h.get('volWeight', 0.5)))
    pj, pb = float(h.get('pJoin') or 0), float(h.get('pBranch') or 0)
    gates = torch.tensor(gates_of(h), dtype=S.dt, device=S.dev).view(1, 5)
    idx = torch.from_numpy(unb64(req['idx'], np.int32).astype(np.int64)).to(S.dev)
    batch = int(req.get('batch', 64))
    g = torch.Generator(device=S.dev)
    g.manual_seed(int(req['seed']) & 0x7FFFFFFF)
    G = graphed(batch) if idx.numel() >= batch else None
    count = 0
    t0 = time.time()
    for _ in range(int(req.get('epochs', 1))):
        order = idx[torch.randperm(idx.numel(), generator=g, device=S.dev)]
        for s in range(0, order.numel(), batch):
            ids = order[s:s + batch]
            B = ids.numel()
            step += 1
            S.hp['c1'].fill_(1 - 0.9 ** step)
            S.hp['c2'].fill_(1 - 0.999 ** step)
            scale = net.sample_scale(gates, B, pb, g)
            mm, sm = net.sample_masks(net.micro, B, pj, g), net.sample_masks(net.swing, B, pj, g)
            if G is not None and B == G.B:
                G.step(ids, scale, mm, sm)
            else:
                train_step(ids, scale, mm, sm, B)
            count += B
    loss = float(S.loss)  # the one host sync of the call
    secs = time.time() - t0
    W = S.W.detach()
    return {'w': b64(W.double().cpu().numpy()), 'm': b64(S.m.double().cpu().numpy()), 'v': b64(S.v.double().cpu().numpy()), 'step': step,
            'loss': loss / max(1, count), 'secs': secs, 'samples': count, 'graph': G is not None}


def forecast(req: dict) -> dict:
    net = S.net
    w = torch.tensor(unb64(req['w'], np.float64), dtype=S.dt, device=S.dev)
    idx = torch.from_numpy(unb64(req['idx'], np.int32).astype(np.int64)).to(S.dev)
    gt = torch.tensor(req['gates'], dtype=S.dt, device=S.dev).view(1, 5)
    outs = []
    with torch.no_grad():
        for s in range(0, idx.numel(), 4096):
            ids = idx[s:s + 4096]
            outs.append(net.forward(w, batch_inputs(ids), gt.expand(ids.numel(), 5)))
    out = torch.cat(outs) if outs else torch.zeros((0, 3), dtype=S.dt, device=S.dev)
    return {'out': b64(out.float().cpu().numpy())}


def explicit(req: dict) -> tuple:
    d = S.net.d
    B = int(req['b'])
    t = lambda k, *shape: torch.tensor(unb64(req['x'][k], np.float64), dtype=S.dt, device=S.dev).view(B, *shape)
    x = {'micro': t('micro', d['mT'], d['mF']), 'swing': t('swing', d['sT'], d['sF']), 'trend': t('trend', d['tT'], d['tF']), 'macro': t('macro', d['dT'], d['dF']), 'ctx': t('ctx', d['cF'])}
    scale = torch.tensor(unb64(req['scale'], np.float64), dtype=S.dt, device=S.dev).view(B, 5)
    mk = lambda k, plan: torch.tensor(unb64(req[k], np.float64), dtype=S.dt, device=S.dev).view(B, plan.joins, 2) if req.get(k) else None
    return x, scale, mk('mmask', S.net.micro), mk('smask', S.net.swing)


def forward(req: dict) -> dict:
    w = torch.tensor(unb64(req['w'], np.float64), dtype=S.dt, device=S.dev)
    x, scale, mm, sm = explicit(req)
    with torch.no_grad():
        out = S.net.forward(w, x, scale, mm, sm)
    return {'out': b64(out.double().cpu().numpy())}


def grad(req: dict) -> dict:
    p = torch.tensor(unb64(req['w'], np.float64), dtype=S.dt, device=S.dev).requires_grad_(True)
    x, scale, mm, sm = explicit(req)
    y = torch.tensor(unb64(req['y'], np.float64), dtype=S.dt, device=S.dev).view(-1, 3)
    loss = loss_of(S.net.forward(p, x, scale, mm, sm), y, float(req['volWeight']))
    loss.backward()
    return {'grad': b64(p.grad.double().cpu().numpy()), 'loss': float(loss)}


HANDLERS = {'init': init, 'train': train, 'forecast': forecast, 'forward': forward, 'grad': grad}


def main() -> None:
    # Replies only on the real stdout; anything a library prints goes to stderr (the log), never into the replies.
    replies = sys.stdout
    sys.stdout = sys.stderr
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if req.get('type') == 'quit':
                break
            out = HANDLERS[req['type']](req)
            reply = {'ok': True, **out}
        except Exception:  # noqa: BLE001
            reply = {'ok': False, 'error': traceback.format_exc()}
        replies.write(json.dumps(reply) + '\n')
        replies.flush()


if __name__ == '__main__':
    main()
