const fs = require('fs');
let code = fs.readFileSync('spotTAEngine.ts', 'utf8');

const targetConf1 = `    // Tool 5: Doji Reversals and Wildcards
    if (spotTA.isDoji && spotTA.dojiType === 'STANDARD_DOJI') {
      activeTools.push(\`Wildcard Indecision Doji\`);
    } else if (spotTA.isDoji && spotTA.dojiType === 'DRAGONFLY') {
      activeTools.push(\`Dragonfly Doji Reversal\`);
    }`;

const newConf1 = `    // Tool 5: Doji Reversals and Wildcards
    if (spotTA.isDoji && spotTA.dojiType === 'STANDARD_DOJI') {
      activeTools.push(\`Wildcard Indecision Doji\`);
    } else if (spotTA.isDoji && spotTA.dojiType === 'DRAGONFLY') {
      activeTools.push(\`Dragonfly Doji Reversal\`);
    }

    // Tool 7: Anchored VWAP Mean Reversion & Support Bounce
    if (spotTA.anchoredVwapDistancePct !== undefined && spotTA.anchoredVwapDistancePct < 0.01 && spotTA.anchoredVwapDistancePct > -0.01) {
       activeTools.push(\`Anchored VWAP Support Bounce (\${(spotTA.anchoredVwapDistancePct*100).toFixed(2)}% proximity)\`);
    }`;

code = code.replace(targetConf1, newConf1);

const targetConf2 = `    // Tool 5: Doji Reversals and Wildcards
    if (spotTA.isDoji && spotTA.dojiType === 'STANDARD_DOJI') {
      activeTools.push(\`Wildcard Indecision Doji\`);
    } else if (spotTA.isDoji && spotTA.dojiType === 'GRAVESTONE') {
      activeTools.push(\`Gravestone Doji Reversal\`);
    }`;

const newConf2 = `    // Tool 5: Doji Reversals and Wildcards
    if (spotTA.isDoji && spotTA.dojiType === 'STANDARD_DOJI') {
      activeTools.push(\`Wildcard Indecision Doji\`);
    } else if (spotTA.isDoji && spotTA.dojiType === 'GRAVESTONE') {
      activeTools.push(\`Gravestone Doji Reversal\`);
    }

    // Tool 7: Anchored VWAP Resistance Rejection
    if (spotTA.anchoredVwapDistancePct !== undefined && spotTA.anchoredVwapDistancePct < 0.01 && spotTA.anchoredVwapDistancePct > -0.01) {
       activeTools.push(\`Anchored VWAP Resistance Rejection (\${(spotTA.anchoredVwapDistancePct*100).toFixed(2)}% proximity)\`);
    }`;

code = code.replace(targetConf2, newConf2);

fs.writeFileSync('spotTAEngine.ts', code, 'utf8');
