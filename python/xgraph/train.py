"""Cross-asset graph network trainer for research/trainCrossGraph.ts (PyTorch engine).

The same network as bot/ta/crossGraph.ts, with the same flat weight layout, so either engine's weights run in the other
and the live bot keeps running the TypeScript forward pass:

    h_i = tanh(W1 x_i + b1)
    a_ij = softmax over valid j != i of beta * corr_ij
    m_i = sum_j a_ij h_j
    z_i = tanh(W2 h_i + U2 m_i + b2)
    y_i = Wo z_i + bo

Usage: python train.py job.json. The job names a directory with float64 binaries x.f64 (S x N x F, z-scored inputs,
padded nodes 0), c.f64 (S x N x N correlations), y.f64 (S x N x O targets, NaN = none), m.f64 (S x N, 1 = a real node)
and w.f64 (initial weights), and the training settings. Writes w_out.f64 (and, with "forward": true, y_out.f64: the
outputs for every sample) and prints one JSON line {"ok": true, "loss": ...}. The update is research/trainCrossGraph.ts
fitTs's: minibatch Adam on the summed squared error over the batch's labelled outputs divided by their count, L2 on every
weight but beta.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
import torch


def views(w: torch.Tensor, L: dict, F: int, H: int, O: int):
    W1 = w[L['W1']:L['W1'] + H * F].view(H, F)
    b1 = w[L['b1']:L['b1'] + H]
    beta = w[L['beta']]
    W2 = w[L['W2']:L['W2'] + H * H].view(H, H)
    U2 = w[L['U2']:L['U2'] + H * H].view(H, H)
    b2 = w[L['b2']:L['b2'] + H]
    Wo = w[L['Wo']:L['Wo'] + O * H].view(O, H)
    bo = w[L['bo']:L['bo'] + O]
    return W1, b1, beta, W2, U2, b2, Wo, bo


def forward(w: torch.Tensor, X: torch.Tensor, C: torch.Tensor, M: torch.Tensor, L: dict, F: int, H: int, O: int) -> torch.Tensor:
    W1, b1, beta, W2, U2, b2, Wo, bo = views(w, L, F, H, O)
    N = X.shape[1]
    h = torch.tanh(X @ W1.T + b1)
    eye = torch.eye(N, dtype=torch.bool, device=X.device)
    valid = (M[:, None, :] > 0) & ~eye[None, :, :]
    logits = (beta * C).masked_fill(~valid, float('-inf'))
    a = torch.softmax(logits, dim=-1)
    a = torch.nan_to_num(a, nan=0.0)  # a node with no neighbours
    m = a @ h
    z = torch.tanh(h @ W2.T + m @ U2.T + b2)
    return z @ Wo.T + bo


def main() -> None:
    job = json.load(open(sys.argv[1]))
    d = job['dir']
    S, N, F, O, H = job['S'], job['N'], job['F'], job['O'], job['H']
    L = job['layout']
    torch.set_default_dtype(torch.float64)
    # The laptop trainer's resource plan (research/trainerResources.ts) sets the thread count; else PyTorch's default.
    if os.environ.get('TA_NET_TORCH_THREADS'):
        torch.set_num_threads(max(1, int(os.environ['TA_NET_TORCH_THREADS'])))
    torch.manual_seed(int(job.get('seed', 1)))
    load = lambda name, shape: torch.from_numpy(np.fromfile(os.path.join(d, name), dtype=np.float64).reshape(shape).copy())
    X, C, Y, M = load('x.f64', (S, N, F)), load('c.f64', (S, N, N)), load('y.f64', (S, N, O)), load('m.f64', (S, N))
    w = load('w.f64', (-1,))
    lab = torch.isfinite(Y) & (M[:, :, None] > 0)
    Yz = torch.where(lab, Y, torch.zeros_like(Y))
    if job.get('forward'):
        with torch.no_grad():
            np.asarray(forward(w, X, C, M, L, F, H, O).numpy(), dtype=np.float64).tofile(os.path.join(d, 'y_out.f64'))
        w.numpy().tofile(os.path.join(d, 'w_out.f64'))
        print(json.dumps({'ok': True, 'loss': None}))
        return
    lr, l2, B, epochs = float(job['lr']), float(job['l2']), int(job['batch']), int(job['epochs'])
    decay = torch.ones_like(w) * l2
    decay[L['beta']] = 0.0
    mA, vA = torch.zeros_like(w), torch.zeros_like(w)
    rng = np.random.default_rng(int(job.get('seed', 1)))
    step, last = 0, float('nan')
    for _ in range(epochs):
        order = rng.permutation(S)
        tot, cnt = 0.0, 0
        for b0 in range(0, S, B):
            idx = torch.from_numpy(order[b0:b0 + B])
            lb = lab[idx]
            c = int(lb.sum())
            if c == 0:
                continue
            wv = w.clone().requires_grad_(True)
            y = forward(wv, X[idx], C[idx], M[idx], L, F, H, O)
            se = torch.where(lb, (y - Yz[idx]) ** 2, torch.zeros_like(y)).sum()
            (se / c).backward()
            g = wv.grad.detach() + decay * w
            step += 1
            mA = 0.9 * mA + 0.1 * g
            vA = 0.999 * vA + 0.001 * g * g
            w = w - (lr * mA / (1 - 0.9 ** step)) / (torch.sqrt(vA / (1 - 0.999 ** step)) + 1e-8)
            tot += float(se.detach())
            cnt += c
        last = tot / cnt if cnt else float('nan')
    w.numpy().tofile(os.path.join(d, 'w_out.f64'))
    print(json.dumps({'ok': True, 'loss': last}))


if __name__ == '__main__':
    try:
        main()
    except Exception as e:  # reported to the caller on stderr with a non-zero exit
        print(f'xgraph torch trainer: {e!r}', file=sys.stderr)
        sys.exit(1)
