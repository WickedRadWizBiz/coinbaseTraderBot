import { SmartTrailingState } from './smartTrailingEngine';

export interface SmartTrailingEvaluationInput {
  pnlRatio: number;
  peakPnlRatio: number;
  entryPrice: number;
  size: number;
  side: 'YES' | 'NO';
  currentMarketPrice: number;
  baseDynamicTP: number;
  currentState?: Partial<SmartTrailingState>;
  minDollarTarget?: number;
  maxDollarTarget?: number;
  isPerpetual?: boolean;
  spotDataMetrics?: {
    directionalImpact: number;
    volSurge: number;
    rsi: number;
    isConsolidating: boolean;
  };
}
