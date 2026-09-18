const fs = require('fs');
let code = fs.readFileSync('spotTAEngine.ts', 'utf8');

const targetInterface = `export interface SpotTAMetrics {
  pair: string;
  price: number;
  rsi: number;
  ichimokuState: 'BULLISH_CLOUD' | 'BEARISH_CLOUD' | 'NEUTRAL_IN_CLOUD';`;

const newInterface = `export interface SpotTAMetrics {
  pair: string;
  price: number;
  rsi: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  percentB: number;
  bandWidth: number;
  ichimokuState: 'BULLISH_CLOUD' | 'BEARISH_CLOUD' | 'NEUTRAL_IN_CLOUD';`;

code = code.replace(targetInterface, newInterface);

const targetReturn1 = `      rsi: 50,
      ichimokuState: 'NEUTRAL_IN_CLOUD',`;

const newReturn1 = `      rsi: 50,
      bbUpper: 0,
      bbMiddle: 0,
      bbLower: 0,
      percentB: 0.5,
      bandWidth: 0,
      ichimokuState: 'NEUTRAL_IN_CLOUD',`;
      
code = code.replace(targetReturn1, newReturn1);

fs.writeFileSync('spotTAEngine.ts', code, 'utf8');
