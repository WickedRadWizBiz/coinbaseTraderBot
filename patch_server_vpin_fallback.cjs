const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetObj = `        tradeFlowImbalance: ofi * 0.9,
        vpin: 0.32,
        micropriceDrift: 0.0008,
        cancelToFillRatio: 1.8,`;

const newObj = `        tradeFlowImbalance: ofi * 0.9,
        vpin: Math.min(1.0, Math.abs((spotTA.macdHist || 0) * 10) + Math.abs(ofi) * 0.5),
        micropriceDrift: (() => {
            const m = (bidVol + askVol) > 0 ? (bidVol + askVol) : 1;
            return Math.abs(ofi) * 0.005; // simplified fallback
        })(),
        cancelToFillRatio: 1.0 + Math.abs(ofi) * 2.5,`;

code = code.replace(targetObj, newObj);
fs.writeFileSync('server.ts', code, 'utf8');
