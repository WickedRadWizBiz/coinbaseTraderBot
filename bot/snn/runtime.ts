// Message handler that owns all SNN state. Runs inside the worker thread (bot/snn/worker.ts) or,
// as a fallback, in-process. The main thread never touches network state directly.

import { SnnNetwork, type ColumnInput, type ContractQuery, type ContractScore, type SnnCheckpoint, type SnnModelFile } from './network';
import type { SnnParams } from './params';

export type SnnRequest =
  | { id: number; type: 'init'; params: SnnParams; whitelist?: string[]; model?: SnnModelFile; checkpoint?: SnnCheckpoint }
  | { id: number; type: 'step'; now: number; inputs: ColumnInput[]; queries: ContractQuery[] }
  | { id: number; type: 'settle'; ticker: string; result: 'yes' | 'no'; now: number }
  | { id: number; type: 'checkpoint' }
  | { id: number; type: 'status' };

export interface StepReply { scores: ContractScore[]; salience: Record<string, number>; top?: string; shadow: boolean; freezeLearning: boolean; alerts: string[]; steps: number; computeMs: number }

export type SnnReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export class SnnRuntime {
  net?: SnnNetwork;
  restoredFrom?: string;

  handle(m: SnnRequest): SnnReply {
    try {
      return { id: m.id, ok: true, result: this.dispatch(m) };
    } catch (e) {
      return { id: m.id, ok: false, error: (e as Error).message };
    }
  }

  private dispatch(m: SnnRequest): unknown {
    if (m.type === 'init') {
      this.net = new SnnNetwork(m.params, { whitelist: m.whitelist, model: m.model });
      if (m.checkpoint) {
        try { this.net.restore(m.checkpoint); this.restoredFrom = `checkpoint @ ${new Date(m.checkpoint.lastTs).toISOString()}`; }
        catch (e) { this.restoredFrom = `checkpoint rejected: ${(e as Error).message}`; }
      }
      return { version: this.net.version, restoredFrom: this.restoredFrom ?? null };
    }
    const net = this.net;
    if (!net) throw new Error('SNN not initialised');
    switch (m.type) {
      case 'step': {
        const t0 = performance.now();
        const r = net.step(m.now, m.inputs);
        const scores = net.score(m.queries, m.now);
        const reply: StepReply = { scores, salience: r.salience, top: r.top, shadow: net.health.shadow, freezeLearning: net.health.freezeLearning, alerts: net.health.alerts, steps: r.steps, computeMs: performance.now() - t0 };
        return reply;
      }
      case 'settle': return net.settle(m.ticker, m.result, m.now);
      case 'checkpoint': return net.serialize();
      case 'status': return { ...net.status(), restoredFrom: this.restoredFrom ?? null };
    }
  }
}
