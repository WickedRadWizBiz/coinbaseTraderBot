"""The TA network (bot/ta/branchNet.ts) in PyTorch, for training on the GPU.

The weights are ONE flat tensor laid out exactly like the TypeScript Float64Array (the layout and the fractal
convolution trees come from TypeScript in the init message, never re-derived here), so a member's weights and
AdamW moments move between the two engines unchanged and the live bot keeps running the network in TypeScript.
Forward is batched; the gradient comes from autograd (tests/taNetTorch.test.ts checks outputs and gradients against
branchForward / branchBackward). Only the flat variant is supported (the grouped one trains in TypeScript).

Branches (B = batch):
  micro  (B, 32, 5)  -> 1x1 projection + tanh -> fractal block -> [mean over bars, last bar]
  swing  (B, 48, 5)  -> the same
  trend  (B, 12, tF) -> GRU, last hidden state
  macro  (B, 30, dF) -> tanh embeddings, attention with today's embedding as the query -> [attended, today]
  ctx    (B, cF)     -> dense tanh
  merge: concat(scale x branch outputs) -> dense tanh -> [logit up 1h, logit up 4h, vol 4h]
"""
from __future__ import annotations

import math

import torch
import torch.nn.functional as Fn

KERNEL = 3


class Plan:
    """A fractal block's expansion tree (bot/ta/fractal.ts buildFractal), as sent by TypeScript."""

    def __init__(self, plan: dict, channels: int):
        self.root = plan['root']
        self.joins = int(plan['joins'])
        self.convs = plan['convs']
        self.depth = max(c['col'] for c in self.convs)
        self.channels = channels
        # Column masks (keep exactly one column through the block): per column, the active inputs of every join;
        # joins the walk never reaches stay [1, 1] (they sit inside an inactive path: weighted 0 upstream).
        self.column_masks = []
        for col in range(1, self.depth + 1):
            m = [[1.0, 1.0] for _ in range(self.joins)]
            self._walk(self.root, col, m)
            self.column_masks.append(m)

    def _walk(self, n: dict, col: int, m: list) -> None:
        if n['t'] == 'conv':
            return
        if n['t'] == 'seq':
            self._walk(n['a'], col, m)
            self._walk(n['b'], col, m)
            return
        if col <= 1:
            m[n['id']] = [1.0, 0.0]
            self._walk(n['kids'][0], 1, m)
            return
        m[n['id']] = [0.0, 1.0]
        self._walk(n['kids'][1], col - 1, m)


class TaNet:
    def __init__(self, dims: dict, layout: dict, plans: dict, device: torch.device, dtype: torch.dtype = torch.float32):
        if dims.get('fam'):
            raise ValueError('the grouped TA network trains in TypeScript')
        self.d = dims
        self.L = {k: (int(v['off']), int(v['n'])) for k, v in layout.items()}
        self.size = max(o + n for o, n in self.L.values())
        self.micro = Plan(plans['micro'], dims['mC'])
        self.swing = Plan(plans['swing'], dims['sC'])
        self.device, self.dtype = device, dtype
        self.columns = {id(pl): torch.tensor(pl.column_masks, dtype=dtype, device=device) for pl in (self.micro, self.swing)}
        # Weight decay applies to weights and kernels, not biases (names starting with 'b'), as in TypeScript.
        mask = torch.zeros(self.size, dtype=dtype, device=device)
        for name, (o, n) in self.L.items():
            if not name.startswith('b'):
                mask[o:o + n] = 1
        self.decay_mask = mask

    # ---- parameter views ----------------------------------------------------------------------------------
    def v(self, p: torch.Tensor, name: str, *shape: int) -> torch.Tensor:
        o, n = self.L[name]
        return p[o:o + n].view(*shape) if shape else p[o:o + n]

    def conv_w(self, p: torch.Tensor, base: str, cid: int, C: int) -> tuple[torch.Tensor, torch.Tensor]:
        o = self.L[base][0] + cid * (C * KERNEL * C + C)
        # TypeScript index (o * K + k) * C + i  ->  (out, K, in)  ->  conv1d weight (out, in, K).
        w = p[o:o + C * KERNEL * C].view(C, KERNEL, C).permute(0, 2, 1)
        b = p[o + C * KERNEL * C:o + C * KERNEL * C + C]
        return w, b

    # ---- blocks -------------------------------------------------------------------------------------------
    def fractal(self, p: torch.Tensor, base: str, plan: Plan, x: torch.Tensor, masks: torch.Tensor | None) -> torch.Tensor:
        """x: (B, C, T). masks: (B, joins, 2) or None (every input active)."""
        C = plan.channels

        def run(n: dict, inp: torch.Tensor) -> torch.Tensor:
            if n['t'] == 'conv':
                w, b = self.conv_w(p, base, n['id'], C)
                dil = int(n['dil'])
                return torch.tanh(Fn.conv1d(Fn.pad(inp, ((KERNEL - 1) * dil, 0)), w, b, dilation=dil))
            if n['t'] == 'seq':
                return run(n['b'], run(n['a'], inp))
            y0 = run(n['kids'][0], inp)
            y1 = run(n['kids'][1], inp)
            if masks is None:
                return (y0 + y1) / 2
            a = masks[:, n['id'], :]
            a0, a1 = a[:, 0].view(-1, 1, 1), a[:, 1].view(-1, 1, 1)
            return (a0 * y0 + a1 * y1) / (a0 + a1)

        return run(plan.root, x)

    def forward(self, p: torch.Tensor, x: dict, scale: torch.Tensor, mmask: torch.Tensor | None = None, smask: torch.Tensor | None = None) -> torch.Tensor:
        """x: micro (B,mT,mF), swing (B,sT,sF), trend (B,tT,tF), macro (B,dT,dF), ctx (B,cF), normalised.
        scale: (B, 5) per-branch factors (gate / keep, 0 for a dropped branch)."""
        d = self.d
        parts = []
        for key, wn, bn, F, C, base, plan, msk, si in (
            ('micro', 'Wpm', 'bpm', d['mF'], d['mC'], 'Fm', self.micro, mmask, 0),
            ('swing', 'Wps', 'bps', d['sF'], d['sC'], 'Fs', self.swing, smask, 1),
        ):
            proj = torch.tanh(x[key] @ self.v(p, wn, C, F).T + self.v(p, bn))  # (B, T, C)
            y = self.fractal(p, base, plan, proj.transpose(1, 2), msk)      # (B, C, T)
            sc = scale[:, si:si + 1]
            parts += [sc * y.mean(dim=2), sc * y[:, :, -1]]
        # trend: GRU
        H, F = d['tH'], d['tF']
        xt = x['trend']
        B = xt.shape[0]
        h = torch.zeros(B, H, dtype=self.dtype, device=self.device)
        Wz, Wr, Wh = (self.v(p, f'W{g}', H, F) for g in 'zrh')
        Uz, Ur, Uh = (self.v(p, f'U{g}', H, H) for g in 'zrh')
        bz, br, bh = (self.v(p, f'b{g}') for g in 'zrh')
        xz, xr, xh = xt @ Wz.T + bz, xt @ Wr.T + br, xt @ Wh.T + bh
        for s in range(d['tT']):
            z = torch.sigmoid(xz[:, s] + h @ Uz.T)
            r = torch.sigmoid(xr[:, s] + h @ Ur.T)
            hh = torch.tanh(xh[:, s] + (r * h) @ Uh.T)
            h = (1 - z) * h + z * hh
        parts.append(scale[:, 2:3] * h)
        # macro: attention with today's embedding as the query
        E, D = d['dE'], d['dF']
        e = torch.tanh(x['macro'] @ self.v(p, 'We', E, D).T + self.v(p, 'be'))  # (B, dT, E)
        last = e[:, -1]
        q = last @ self.v(p, 'Wq', E, E).T
        k = e @ self.v(p, 'Wk', E, E).T
        a = torch.softmax((k * q.unsqueeze(1)).sum(-1) / math.sqrt(E), dim=1)  # (B, dT)
        att = (a.unsqueeze(-1) * e).sum(1)
        parts += [scale[:, 3:4] * att, scale[:, 3:4] * last]
        # context
        hc = torch.tanh(x['ctx'] @ self.v(p, 'Wc', d['cH'], d['cF']).T + self.v(p, 'bc'))
        parts.append(scale[:, 4:5] * hc)
        u = torch.cat(parts, dim=1)
        m = torch.tanh(u @ self.v(p, 'W1', d['hM'], u.shape[1]).T + self.v(p, 'b1'))
        return m @ self.v(p, 'W2', d['nOut'], d['hM']).T + self.v(p, 'b2')

    # ---- training noise (research/trainTaNet.ts sampleDrop) -------------------------------------------------
    # Everything stays on the device (no host round trip per batch, so the GPU never waits on Python).
    def sample_masks(self, plan: Plan, B: int, pj: float, g: torch.Generator) -> torch.Tensor:
        """Half the samples drop join inputs locally (each with probability pj, at least one kept), half keep one
        random column through the whole block. pj = 0: every input active."""
        dev = self.device
        if pj <= 0:
            return torch.ones(B, plan.joins, 2, dtype=self.dtype, device=dev)
        u = torch.rand(B, plan.joins, 2, generator=g, device=dev)
        local = (u >= pj).to(self.dtype)
        both_off = (local.sum(-1) == 0)
        pick = (torch.rand(B, plan.joins, generator=g, device=dev) < 0.5)
        local[..., 0] = torch.where(both_off & pick, torch.ones_like(local[..., 0]), local[..., 0])
        local[..., 1] = torch.where(both_off & ~pick, torch.ones_like(local[..., 1]), local[..., 1])
        which = torch.randint(0, plan.depth, (B,), generator=g, device=dev)
        column = self.columns[id(plan)][which]
        use_local = (torch.rand(B, generator=g, device=dev) < 0.5).view(B, 1, 1)
        return torch.where(use_local, local, column)

    def sample_scale(self, gates: torch.Tensor, B: int, pb: float, g: torch.Generator) -> torch.Tensor:
        """gates: (1, 5). Each branch dropped with probability pb (at least one kept), the rest scaled by 1 / keep."""
        if pb <= 0:
            return gates.expand(B, 5)
        on = torch.rand(B, 5, generator=g, device=self.device) >= pb
        none = ~on.any(dim=1, keepdim=True)
        force = Fn.one_hot(torch.randint(0, 5, (B,), generator=g, device=self.device), 5).bool()
        on = on | (force & none)
        return on.to(self.dtype) * gates / (1 - pb)


def loss_of(out: torch.Tensor, y: torch.Tensor, vol_weight: float | torch.Tensor) -> torch.Tensor:
    """research: branchLoss summed over the batch (BCE on the two direction logits, 0.5 x volWeight x squared error
    on vol; missing targets skipped). Masked rather than indexed: no host sync, fixed shapes (CUDA graphs)."""
    ok = torch.isfinite(y)
    okf = ok.to(out.dtype)
    y0 = torch.where(ok, y, torch.zeros_like(y))
    bce = Fn.binary_cross_entropy_with_logits(out[:, :2], y0[:, :2], reduction='none')
    e = (out[:, 2] - y0[:, 2]) * okf[:, 2]
    return (bce * okf[:, :2]).sum() + vol_weight * 0.5 * (e * e).sum()
