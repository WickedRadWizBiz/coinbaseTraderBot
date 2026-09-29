// Offline MLP trainer (full-batch Adam, binary cross-entropy, L2), producing
// DenseLayer weights in the exact format bot/model/metaModel.ts loads.
// Output logit = network(x_normalized) + x_raw[residual] (residual on the
// fair-value log-odds), so an untrained or heavily regularized network
// reproduces the fair value.

import type { DenseLayer } from '../bot/model/metaModel';
import { forward } from '../bot/model/metaModel';
import { sigmoid } from '../bot/util/num';
import { rng } from './stats';

export interface TrainOptions {
  hidden: number;        // 0 = logistic regression on top of the residual
  l2: number;
  lr: number;
  maxEpochs: number;
  patience: number;
  seed: number;
  residual: number;      // feature index added raw to the output logit
}

export interface Normalization { mean: number[]; std: number[] }

export function fitNormalization(X: number[][]): Normalization {
  const d = X[0].length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j] / X.length;
  for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2 / X.length;
  return { mean, std: std.map((v) => Math.sqrt(v) || 1) };
}

function normalize(X: number[][], n: Normalization): number[][] {
  return X.map((x) => x.map((v, j) => (v - n.mean[j]) / n.std[j]));
}

export function predictLogits(layers: DenseLayer[], norm: Normalization, X: number[][], residual: number): number[] {
  return X.map((x) => {
    let h = x.map((v, j) => (v - norm.mean[j]) / norm.std[j]);
    for (const l of layers) h = forward(l, h);
    return h[0] + x[residual];
  });
}

function initLayers(d: number, hidden: number, seed: number): DenseLayer[] {
  const r = rng(seed);
  const g = (scale: number) => (r() * 2 - 1) * scale;
  if (hidden === 0) return [{ weights: [new Array(d).fill(0)], bias: [0], activation: 'linear' }];
  return [
    { weights: Array.from({ length: hidden }, () => Array.from({ length: d }, () => g(1 / Math.sqrt(d)))), bias: new Array(hidden).fill(0), activation: 'tanh' },
    // Output layer starts at zero: the initial model IS the fair value.
    { weights: [new Array(hidden).fill(0)], bias: [0], activation: 'linear' },
  ];
}

function loss(layers: DenseLayer[], Xn: number[][], Xraw: number[][], y: number[], residual: number, l2: number): number {
  let s = 0;
  for (let i = 0; i < Xn.length; i++) {
    let h = Xn[i];
    for (const l of layers) h = forward(l, h);
    const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(h[0] + Xraw[i][residual])));
    s += y[i] ? -Math.log(p) : -Math.log(1 - p);
  }
  let reg = 0;
  for (const l of layers) for (const row of l.weights) for (const w of row) reg += w * w;
  return s / Xn.length + l2 * reg;
}

export function train(
  X: number[][], y: number[], Xval: number[][], yval: number[], o: TrainOptions,
): { layers: DenseLayer[]; norm: Normalization; valLoss: number; epochs: number } {
  const norm = fitNormalization(X);
  const Xn = normalize(X, norm);
  const Xvn = normalize(Xval, norm);
  const d = X[0].length;
  let layers = initLayers(d, o.hidden, o.seed);
  // Adam state mirrors the layer shapes.
  const zeros = (ls: DenseLayer[]) => ls.map((l) => ({ w: l.weights.map((r) => r.map(() => 0)), b: l.bias.map(() => 0) }));
  const m = zeros(layers), v = zeros(layers);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  let best = { layers: structuredClone(layers), val: Infinity, epoch: 0 };

  for (let epoch = 1; epoch <= o.maxEpochs; epoch++) {
    const grad = zeros(layers);
    for (let i = 0; i < Xn.length; i++) {
      // Forward with cached activations.
      const acts: number[][] = [Xn[i]];
      for (const l of layers) acts.push(forward(l, acts[acts.length - 1]));
      const p = sigmoid(acts[acts.length - 1][0] + X[i][o.residual]);
      let delta = [p - y[i]]; // dL/dz at output
      for (let li = layers.length - 1; li >= 0; li--) {
        const l = layers[li];
        const input = acts[li];
        const out = acts[li + 1];
        // Activation derivative.
        const dz = delta.map((dv, k) => (l.activation === 'tanh' ? dv * (1 - out[k] * out[k]) : l.activation === 'relu' ? (out[k] > 0 ? dv : 0) : dv));
        for (let k = 0; k < dz.length; k++) {
          grad[li].b[k] += dz[k] / Xn.length;
          for (let j = 0; j < input.length; j++) grad[li].w[k][j] += (dz[k] * input[j]) / Xn.length;
        }
        if (li > 0) {
          const prev = new Array(input.length).fill(0);
          for (let k = 0; k < dz.length; k++) for (let j = 0; j < input.length; j++) prev[j] += dz[k] * l.weights[k][j];
          delta = prev;
        }
      }
    }
    // L2 on weights, then Adam update.
    for (let li = 0; li < layers.length; li++) {
      const l = layers[li];
      for (let k = 0; k < l.bias.length; k++) {
        const gb = grad[li].b[k];
        m[li].b[k] = b1 * m[li].b[k] + (1 - b1) * gb;
        v[li].b[k] = b2 * v[li].b[k] + (1 - b2) * gb * gb;
        l.bias[k] -= (o.lr * (m[li].b[k] / (1 - b1 ** epoch))) / (Math.sqrt(v[li].b[k] / (1 - b2 ** epoch)) + eps);
        for (let j = 0; j < l.weights[k].length; j++) {
          const gw = grad[li].w[k][j] + 2 * o.l2 * l.weights[k][j];
          m[li].w[k][j] = b1 * m[li].w[k][j] + (1 - b1) * gw;
          v[li].w[k][j] = b2 * v[li].w[k][j] + (1 - b2) * gw * gw;
          l.weights[k][j] -= (o.lr * (m[li].w[k][j] / (1 - b1 ** epoch))) / (Math.sqrt(v[li].w[k][j] / (1 - b2 ** epoch)) + eps);
        }
      }
    }
    if (epoch % 5 === 0 || epoch === o.maxEpochs) {
      const val = loss(layers, Xvn, Xval, yval, o.residual, 0);
      if (val < best.val - 1e-7) best = { layers: structuredClone(layers), val, epoch };
      else if (epoch - best.epoch > o.patience) break;
    }
  }
  layers = best.layers;
  return { layers, norm, valLoss: best.val, epochs: best.epoch };
}
