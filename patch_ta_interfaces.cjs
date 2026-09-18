const fs = require('fs');
let code = fs.readFileSync('spotTAEngine.ts', 'utf8');

const targetInterface = `  anchoredVwapSlope?: number; // AVWAP 10-period rate of change
  relativeVolume?: number; // RVOL
}`;

const newInterface = `  anchoredVwapSlope?: number; // AVWAP 10-period rate of change
  relativeVolume?: number; // RVOL
  macdRatio?: number; // Normalized MACD r_{MACD}
  forceIndex?: number; // Normalized Force Index
  obvRoc?: number; // Rate of Change of On-Balance Volume
  tnRsi?: number; // Trend-Normalized RSI
  macdHist?: number;
  macd?: number;
}`;

code = code.replace(targetInterface, newInterface);

const targetReturn1 = `      anchoredVwapSlope: 0,
      relativeVolume: 1
    };`;

const newReturn1 = `      anchoredVwapSlope: 0,
      relativeVolume: 1,
      macdRatio: 0,
      forceIndex: 0,
      obvRoc: 0,
      tnRsi: 50,
      macdHist: 0,
      macd: 0
    };`;

code = code.replace(targetReturn1, newReturn1);

fs.writeFileSync('spotTAEngine.ts', code, 'utf8');
