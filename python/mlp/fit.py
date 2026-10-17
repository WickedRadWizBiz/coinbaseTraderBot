"""PyTorch fits for the small MLPs the decision models use (research/mlp.ts train, research/mlpTorch.ts): the same
algorithm as the TypeScript trainer, on the GPU when there is one. Full-batch Adam (bias-corrected, b1 0.9, b2 0.999,
eps 1e-8) on the weighted mean log loss of sigmoid(network(x_norm) + x_raw[residual]), L2 on the weights (not the
biases), a tanh hidden layer (or none), early stopping on the weighted validation log loss checked every 5 epochs.
The initial weights come from TypeScript (its seeded generator), and the result goes back in its DenseLayer layout.

JSON lines over stdin / stdout:
  {"type": "init"}                                     -> device
  {"type": "data", "x": path, "rows", "cols", "y": path, "w": path}   float32 files, NaN = missing
  {"type": "fit", "jobs": [...]}                       -> one result per job (see fit_job)
"""

import base64
import json
import sys

import numpy as np
import torch

DEV = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
DT = torch.float64
S = {}


def unb64(s: str, dtype) -> np.ndarray:
    return np.frombuffer(base64.b64decode(s), dtype=dtype)


def data(req: dict) -> dict:
    x = np.fromfile(req['x'], dtype=np.float32).reshape(req['rows'], req['cols'])
    S['x'] = torch.from_numpy(x.astype(np.float64)).to(DEV)
    S['y'] = torch.from_numpy(np.fromfile(req['y'], dtype=np.float32).astype(np.float64)).to(DEV)
    S['w'] = torch.from_numpy(np.fromfile(req['w'], dtype=np.float32).astype(np.float64)).to(DEV)
    return {'ok': True}


def fit_job(j: dict) -> dict:
    tr = torch.from_numpy(unb64(j['train'], np.int32).astype(np.int64)).to(DEV)
    va = torch.from_numpy(unb64(j['val'], np.int32).astype(np.int64)).to(DEV)
    cols = torch.tensor(j['cols'], dtype=torch.int64, device=DEV)
    X = S['x']
    Xtr, Xva = X[tr][:, cols], X[va][:, cols]
    wtr = S['w'][tr] if j.get('wTrain') is None else torch.from_numpy(unb64(j['wTrain'], np.float32).astype(np.float64)).to(DEV)
    wva = S['w'][va]
    ytr, yva = S['y'][tr], S['y'][va]
    # Normalisation on the training rows, missing values ignored (population std; 1 when constant).
    fin = torch.isfinite(Xtr)
    cnt = fin.sum(0).to(DT)
    mean = torch.where(fin, Xtr, torch.zeros_like(Xtr)).sum(0) / cnt.clamp(min=1)
    mean = torch.where(cnt > 0, mean, torch.zeros_like(mean))
    var = torch.where(fin, (Xtr - mean) ** 2, torch.zeros_like(Xtr)).sum(0)
    std = torch.where(cnt > 1, torch.sqrt(var / cnt.clamp(min=1)), torch.zeros_like(var))
    std = torch.where(std > 0, std, torch.ones_like(std))
    norm = lambda A: torch.where(torch.isfinite(A), (A - mean) / std, torch.zeros_like(A))
    r = j['residual']
    res = lambda A: torch.nan_to_num(A[:, r], nan=0.0, posinf=0.0, neginf=0.0) if r >= 0 else torch.zeros(A.shape[0], dtype=DT, device=DEV)
    ntr, nva, rtr, rva = norm(Xtr), norm(Xva), res(Xtr), res(Xva)
    d, h = Xtr.shape[1], j['hidden']
    if h > 0:
        W1 = torch.from_numpy(unb64(j['init'], np.float64).reshape(h, d).copy()).to(DEV)
        params = [W1, torch.zeros(h, dtype=DT, device=DEV), torch.zeros(1, h, dtype=DT, device=DEV), torch.zeros(1, dtype=DT, device=DEV)]
        is_w = [True, False, True, False]
    else:
        params = [torch.zeros(1, d, dtype=DT, device=DEV), torch.zeros(1, dtype=DT, device=DEV)]
        is_w = [True, False]
    for p in params:
        p.requires_grad_(True)

    def logits(A, rr):
        if h > 0:
            z = torch.tanh(A @ params[0].T + params[1]) @ params[2].T + params[3]
        else:
            z = A @ params[0].T + params[1]
        return z[:, 0] + rr

    wsum_tr = wtr.sum().clamp(min=1e-12)
    m = [torch.zeros_like(p) for p in params]
    v = [torch.zeros_like(p) for p in params]
    b1, b2, eps, lr, l2 = 0.9, 0.999, 1e-8, j['lr'], j['l2']
    best_val, best_epoch, best = float('inf'), 0, [p.detach().clone() for p in params]
    for epoch in range(1, j['maxEpochs'] + 1):
        z = logits(ntr, rtr)
        loss = (wtr * torch.nn.functional.binary_cross_entropy_with_logits(z, ytr, reduction='none')).sum() / wsum_tr
        grads = torch.autograd.grad(loss, params)
        with torch.no_grad():
            for k, p in enumerate(params):
                g = grads[k] + (2 * l2 * p if is_w[k] else 0)
                m[k].mul_(b1).add_((1 - b1) * g)
                v[k].mul_(b2).add_((1 - b2) * g * g)
                p.sub_(lr * (m[k] / (1 - b1 ** epoch)) / (torch.sqrt(v[k] / (1 - b2 ** epoch)) + eps))
            if epoch % 5 == 0 or epoch == j['maxEpochs']:
                pv = torch.sigmoid(logits(nva, rva)).clamp(1e-9, 1 - 1e-9)
                ll = -(yva * torch.log(pv) + (1 - yva) * torch.log(1 - pv))
                val = float((wva * ll).sum() / wva.sum().clamp(min=1e-12))
                if val < best_val - 1e-7:
                    best_val, best_epoch, best = val, epoch, [p.detach().clone() for p in params]
                elif epoch - best_epoch > j['patience']:
                    break
    out = [b.cpu().numpy() for b in best]
    if h > 0:
        layers = [{'weights': out[0].tolist(), 'bias': out[1].tolist(), 'activation': 'tanh'}, {'weights': out[2].tolist(), 'bias': out[3].tolist(), 'activation': 'linear'}]
    else:
        layers = [{'weights': out[0].tolist(), 'bias': out[1].tolist(), 'activation': 'linear'}]
    return {'layers': layers, 'mean': mean.cpu().tolist(), 'std': std.cpu().tolist(), 'valLoss': best_val, 'epochs': best_epoch}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            t = req.get('type')
            if t == 'init':
                rep = {'ok': True, 'device': DEV.type, 'name': torch.cuda.get_device_name(0) if DEV.type == 'cuda' else 'cpu', 'torch': torch.__version__}
            elif t == 'data':
                rep = data(req)
            elif t == 'fit':
                rep = {'ok': True, 'results': [fit_job(j) for j in req['jobs']]}
            else:
                rep = {'ok': False, 'error': f'unknown request {t}'}
        except Exception as e:  # reported to TypeScript, which falls back to its own trainer
            rep = {'ok': False, 'error': f'{type(e).__name__}: {e}'}
        sys.stdout.write(json.dumps(rep) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
