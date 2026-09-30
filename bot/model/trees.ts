// Gradient-boosted decision trees: inference (training is research/gbdt.ts).
// Trees are stored as flat node arrays. A node with f < 0 is a leaf carrying
// its (learning-rate-scaled) value. Missing inputs (NaN) follow each split's
// learned default direction, like LightGBM, so "unavailable" is information
// rather than an imputed mean.

export interface TreeNode {
  /** Feature index; -1 for a leaf. */
  f: number;
  /** Threshold: x[f] <= t goes left. */
  t: number;
  l: number;
  r: number;
  /** Missing values go left when true. */
  ml: boolean;
  /** Leaf value (log-odds). */
  v: number;
}

export interface GbdtModel {
  trees: TreeNode[][];
  baseScore: number;
}

export function treeValue(tree: TreeNode[], x: number[]): number {
  let i = 0;
  for (let guard = 0; guard < 64; guard++) {
    const n = tree[i];
    if (n.f < 0) return n.v;
    const xv = x[n.f];
    i = Number.isFinite(xv) ? (xv <= n.t ? n.l : n.r) : n.ml ? n.l : n.r;
  }
  throw new Error('tree too deep or cyclic');
}

export function gbdtLogit(m: GbdtModel, x: number[]): number {
  let z = m.baseScore;
  for (const t of m.trees) z += treeValue(t, x);
  return z;
}

export function validateGbdt(m: GbdtModel, nFeatures: number): void {
  if (!Number.isFinite(m.baseScore)) throw new Error('gbdt baseScore not finite');
  for (const [k, t] of m.trees.entries()) {
    if (!t.length) throw new Error(`tree ${k} empty`);
    for (const n of t) {
      if (n.f < 0) { if (!Number.isFinite(n.v)) throw new Error(`tree ${k}: leaf not finite`); continue; }
      if (n.f >= nFeatures || !Number.isFinite(n.t)) throw new Error(`tree ${k}: bad split`);
      if (!(n.l > 0 && n.l < t.length && n.r > 0 && n.r < t.length)) throw new Error(`tree ${k}: bad child index`);
    }
  }
}
