const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetStr = `      let currentImbalanceTowards = pos.side === 'YES' ? bidVol / askVol : askVol / bidVol;
      if (!pos.analysisMeta) pos.analysisMeta = {};
      if (pos.analysisMeta.entryImbalance === undefined) {
         pos.analysisMeta.entryImbalance = currentImbalanceTowards;
      }
      
      let imbalanceDelta = currentImbalanceTowards - pos.analysisMeta.entryImbalance;
      dynamicTP = Math.max(0.01, dynamicTP + (imbalanceDelta * 0.05));`;

const replacementStr = `      let currentImbalanceTowards = pos.side === 'YES' ? bidVol / askVol : askVol / bidVol;
      if (!pos.analysisMeta) pos.analysisMeta = {};
      if (pos.analysisMeta.entryOFI === undefined) {
         pos.analysisMeta.entryOFI = ctx.OFI || 0;
      }
      
      const currentOFI = ctx.OFI || 0;
      const ofiDelta = currentOFI - pos.analysisMeta.entryOFI;
      const averageDepth = Math.max(1, (bidVol + askVol) / 2);
      const priceImpact = ofiDelta / averageDepth;
      const directionalImpact = pos.side === 'YES' ? priceImpact : -priceImpact;
      dynamicTP = Math.max(0.01, dynamicTP + directionalImpact * 0.5);`;

code = code.replace(targetStr, replacementStr);
fs.writeFileSync('server.ts', code);
console.log("Done");
