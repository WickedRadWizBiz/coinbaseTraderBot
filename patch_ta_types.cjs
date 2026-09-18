const fs = require('fs');
let code = fs.readFileSync('spotTAEngine.ts', 'utf8');

const targetInterface = `  tenkanSen: number;
  kijunSen: number;
  senkouSpanA: number;
  senkouSpanB: number;
  tenkanKijunCross: 'BULLISH_CROSS' | 'BEARISH_CROSS' | 'NEUTRAL';
  isDoji: boolean;
  dojiType: 'DRAGONFLY' | 'GRAVESTONE' | 'STANDARD_DOJI' | 'NONE';`;

const newInterface = `  tenkanSen: number;
  kijunSen: number;
  senkouSpanA: number;
  senkouSpanB: number;
  priceToTenkan?: number;
  priceToKijun?: number;
  tenkanKijunSpread?: number;
  cloudDistanceA?: number;
  cloudDistanceB?: number;
  ichimokuThickDist?: number;
  tenkanKijunCross: 'BULLISH_CROSS' | 'BEARISH_CROSS' | 'NEUTRAL';
  isDoji: boolean;
  dojiType: 'DRAGONFLY' | 'GRAVESTONE' | 'STANDARD_DOJI' | 'NONE';
  bodyRatio?: number;
  upperShadowRatio?: number;
  lowerShadowRatio?: number;`;

code = code.replace(targetInterface, newInterface);

const targetReturn1 = `      ichimokuState: 'NEUTRAL_IN_CLOUD',
      tenkanSen: 0,
      kijunSen: 0,
      senkouSpanA: 0,
      senkouSpanB: 0,
      tenkanKijunCross: 'NEUTRAL',
      isDoji: false,
      dojiType: 'NONE',`;

const newReturn1 = `      ichimokuState: 'NEUTRAL_IN_CLOUD',
      tenkanSen: 0,
      kijunSen: 0,
      senkouSpanA: 0,
      senkouSpanB: 0,
      priceToTenkan: 0,
      priceToKijun: 0,
      tenkanKijunSpread: 0,
      cloudDistanceA: 0,
      cloudDistanceB: 0,
      ichimokuThickDist: 0,
      tenkanKijunCross: 'NEUTRAL',
      isDoji: false,
      dojiType: 'NONE',
      bodyRatio: 0,
      upperShadowRatio: 0,
      lowerShadowRatio: 0,`;

code = code.replace(targetReturn1, newReturn1);

fs.writeFileSync('spotTAEngine.ts', code, 'utf8');
