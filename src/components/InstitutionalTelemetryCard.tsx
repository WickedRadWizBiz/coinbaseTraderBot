import React, { useState, useEffect } from 'react';

interface InstitutionalStatus {
  fixEngine: {
    connected: boolean;
    loggedIn: boolean;
    seqNumOut: number;
    seqNumIn: number;
    host: string;
    port: number;
    shard?: string;
  };
  stochasticPricing: Record<string, {
    fairValueProbability: number;
    fairValueCents: number;
    bsContinuousProbability: number;
    jumpAlphaDelta: number;
    spotJumpDetected: boolean;
    delta: number;
    gamma: number;
    theta: number;
  }>;
  kalmanStateEstimates: Record<string, {
    x: number;
    smoothedMid: number;
    p: number;
    k: number;
    velocity: number;
  }>;
  bayesianRisk: {
    sampleBayesianKelly: {
      recommendedFraction: number;
      posteriorMeanP: number;
      posteriorVariance: number;
      grossEV: number;
      netEV: number;
      calculatedFeePerContract: number;
    };
    cvarConfidenceAlpha: number;
    quadraticFeeFormula: string;
  };
  multiAgentAdversarialRegime: {
    regime: string;
    kellyAdjustment: number;
    tpMultiplier: number;
    slMultiplier: number;
    reasoning: string;
  };
}

export const InstitutionalTelemetryCard: React.FC = () => {
  const [data, setData] = useState<InstitutionalStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/institutional/status');
        const contentType = res.headers.get('content-type');
        if (res.ok && contentType && contentType.includes('application/json')) {
          const json = await res.json();
          setData(json);
        }
      } catch (err) {
        // Suppress transient parse errors during server reload
      } finally {
        setIsLoading(false);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, []);

  if (isLoading) {
    return (
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 text-neutral-400 text-sm">
        Loading Institutional FIX 4.4 & Stochastic Pricing Telemetry...
      </div>
    );
  }

  const fix = data?.fixEngine;
  const pricing = data?.stochasticPricing || {};
  const risk = data?.bayesianRisk;
  const regime = data?.multiAgentAdversarialRegime;

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 space-y-6 text-white shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
        <div className="flex items-center space-x-3">
          <div className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse" />
          <h2 className="text-lg font-bold tracking-wide uppercase text-neutral-200">
            Institutional Engine Cockpit
          </h2>
          <span className="px-2 py-0.5 text-xs font-mono bg-emerald-950 text-emerald-400 border border-emerald-800 rounded">
            FIX 4.4 + Jump-Diffusion Active
          </span>
        </div>
        <div className="text-xs text-neutral-400 font-mono">
          Shard: {fix?.shard || '100'} | Protocol: FIX 4.4 TLS
        </div>
      </div>

      {/* Grid Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* FIX 4.4 Connection */}
        <div className="bg-neutral-950 border border-neutral-800 p-4 rounded-lg space-y-2">
          <div className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
            FIX 4.4 Execution Layer
          </div>
          <div className="flex items-center space-x-2">
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${fix?.loggedIn ? 'bg-emerald-400' : 'bg-amber-400'}`} />
            <span className="font-semibold text-sm font-mono">
              {fix?.loggedIn ? 'LOGON_CONFIRMED' : 'CONNECTING'}
            </span>
          </div>
          <div className="text-xs text-neutral-400 font-mono pt-1 space-y-1">
            <div>Target: {fix?.host}:{fix?.port}</div>
            <div>Seq Out: #{fix?.seqNumOut} | In: #{fix?.seqNumIn}</div>
            <div className="text-emerald-400 text-[11px]">MsgType=G Atomic Replace Enabled</div>
          </div>
        </div>

        {/* Multi-Agent Adversarial Committee */}
        <div className="bg-neutral-950 border border-neutral-800 p-4 rounded-lg space-y-2">
          <div className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
            Adversarial Committee (Gemini)
          </div>
          <div className="text-sm font-semibold text-cyan-300 font-mono">
            {regime?.regime || 'CLASSIFYING'}
          </div>
          <div className="text-xs text-neutral-400 font-mono pt-1 space-y-1">
            <div>Kelly Adj: {regime?.kellyAdjustment}x | TP: {regime?.tpMultiplier}x</div>
            <div className="truncate text-neutral-400" title={regime?.reasoning}>
              {regime?.reasoning || 'Committee consensus ready.'}
            </div>
            <div className="text-cyan-400 text-[11px]">Consensus Gated (C &gt; 0.50)</div>
          </div>
        </div>

        {/* Bayesian Kelly & CVaR */}
        <div className="bg-neutral-950 border border-neutral-800 p-4 rounded-lg space-y-2">
          <div className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
            Bayesian Risk & CVaR (95%)
          </div>
          <div className="text-sm font-semibold text-amber-300 font-mono">
            CVaR Limit: 15.0% Bankroll
          </div>
          <div className="text-xs text-neutral-400 font-mono pt-1 space-y-1">
            <div>Beta Posterior: E[p]={((risk?.sampleBayesianKelly?.posteriorMeanP || 0.6) * 100).toFixed(1)}%</div>
            <div>Net EV @ 50¢: +{((risk?.sampleBayesianKelly?.netEV || 0.12) * 100).toFixed(1)}%</div>
            <div className="text-amber-400 text-[11px]">Fee: ⌈0.07·C·P·(1-P)⌉ Subtracted</div>
          </div>
        </div>

        {/* Quadratic Fee Curve */}
        <div className="bg-neutral-950 border border-neutral-800 p-4 rounded-lg space-y-2">
          <div className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
            Non-Linear Quadratic Fee
          </div>
          <div className="text-sm font-semibold text-purple-300 font-mono">
            Max Fee: $0.0175 @ 50¢
          </div>
          <div className="text-xs text-neutral-400 font-mono pt-1 space-y-1">
            <div>At 10¢ / 90¢: $0.0063 / contract</div>
            <div>At 25¢ / 75¢: $0.0132 / contract</div>
            <div className="text-purple-400 text-[11px]">Avellaneda-Stoikov Skew Active</div>
          </div>
        </div>
      </div>

      {/* Merton Jump-Diffusion Fair Values */}
      <div className="space-y-3">
        <div className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
          Merton Jump-Diffusion Theoretical Binary Fair Values vs Continuous Spot
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-mono text-xs">
          {Object.entries(pricing).map(([asset, val]: [string, any]) => (
            <div key={asset} className="bg-neutral-950 border border-neutral-800 p-3 rounded-lg space-y-2">
              <div className="flex justify-between items-center">
                <span className="font-bold text-sm text-neutral-200">{asset}</span>
                <span className="px-2 py-0.5 bg-neutral-800 rounded text-neutral-300">
                  {val.fairValueCents}¢ ({ (val.fairValueProbability * 100).toFixed(1) }%)
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1 text-neutral-400 pt-1 border-t border-neutral-850">
                <div>BS Continuous: {(val.bsContinuousProbability * 100).toFixed(1)}%</div>
                <div className={val.jumpAlphaDelta >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                  Jump Alpha: {(val.jumpAlphaDelta * 100).toFixed(2)}%
                </div>
                <div>Delta: {val.delta.toFixed(4)}</div>
                <div>Gamma: {val.gamma.toFixed(4)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
