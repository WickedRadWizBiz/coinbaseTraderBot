const fs = require('fs');
let code = fs.readFileSync('spotTAEngine.ts', 'utf8');

const targetConf1 = `    // Tool 7: Anchored VWAP Resistance Rejection`;
const newConf1 = `    // Tripartite Confluence (RSI, MACD Flip, Anchored VWAP)
    if (spotTA.anchoredVwapDistancePct !== undefined && spotTA.anchoredVwapDistancePct < 0.02 && spotTA.anchoredVwapDistancePct > -0.02) {
       if (spotTA.rsi < 40 && spotTA.macdHist && spotTA.macdHist > 0) {
           activeTools.push(\`Tripartite Confluence (AVWAP Support + RSI < 40 + MACD Flip)\`);
       }
    }
    
    // Fading Capitulation V-Bottom
    if (spotTA.rsi < 15 && spotTA.percentB < -0.1 && spotTA.forceIndex !== undefined && spotTA.forceIndex < -0.05) {
       activeTools.push(\`Panic Capitulation V-Bottom (Force Index spike + BB < -0.1 + RSI < 15)\`);
    }

    // Tool 7: Anchored VWAP Resistance Rejection`;

code = code.replace(targetConf1, newConf1);

const targetConf2 = `    // Tool 1: Orderbook Depth Imbalance (Asks > Bids) + Volume Surge Filter`;

const newConf2 = `    // Systemic Momentum Cascade (Session Logic + BB < 0 + VWAP)
    if (spotTA.percentB < 0 && spotTA.vwapDistancePct < 0 && spotTA.rsi < 40) {
        activeTools.push(\`Systemic Momentum Cascade (BB% < 0 + Below VWAP + Fast RSI Deceleration)\`);
    }

    // Fading Euphoria (FOMO Exhaustion)
    if (spotTA.rsi > 85 && spotTA.volumeSurgeRatio > 2 && spotTA.macdHist && spotTA.macdHist > 0) {
        activeTools.push(\`FOMO Herding Exhaustion (RSI > 85 + Vol Surge + Expanding MACD)\`);
    }

    // Tool 1: Orderbook Depth Imbalance (Asks > Bids) + Volume Surge Filter`;

code = code.replace(targetConf2, newConf2);

fs.writeFileSync('spotTAEngine.ts', code, 'utf8');
