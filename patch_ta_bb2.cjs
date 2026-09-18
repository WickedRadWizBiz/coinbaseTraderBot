const fs = require('fs');
let code = fs.readFileSync('spotTAEngine.ts', 'utf8');

const targetYesRsi = `    // Tool 3: RSI Momentum / Reversion Zone
    if (spotTA.rsi <= 48) {
      activeTools.push(\`Oversold RSI (\${spotTA.rsi})\`);
    }`;

const newYesRsi = `    // Tool 3: RSI Momentum / Reversion Zone
    if (spotTA.rsi <= 48) {
      activeTools.push(\`Oversold RSI (\${spotTA.rsi})\`);
    }

    // Tool 6: Bollinger Band Lower Touch (Mean Reversion) or Band Walk
    if (spotTA.percentB <= 0.05) {
       activeTools.push(\`Bollinger Lower Band Touch/Breach (\${spotTA.percentB.toFixed(2)} %B)\`);
    } else if (spotTA.percentB >= 0.95 && spotTA.bandWidth > 0.05) {
       activeTools.push(\`Bollinger Band Walk Uptrend (Squeeze Breakout)\`);
    }`;

code = code.replace(targetYesRsi, newYesRsi);

const targetNoRsi = `    // Tool 3: RSI Momentum / Reversion Zone
    if (spotTA.rsi >= 52) {
      activeTools.push(\`Overbought RSI (\${spotTA.rsi})\`);
    }`;
    
const newNoRsi = `    // Tool 3: RSI Momentum / Reversion Zone
    if (spotTA.rsi >= 52) {
      activeTools.push(\`Overbought RSI (\${spotTA.rsi})\`);
    }

    // Tool 6: Bollinger Band Upper Touch (Mean Reversion) or Band Walk
    if (spotTA.percentB >= 0.95) {
       activeTools.push(\`Bollinger Upper Band Touch/Breach (\${spotTA.percentB.toFixed(2)} %B)\`);
    } else if (spotTA.percentB <= 0.05 && spotTA.bandWidth > 0.05) {
       activeTools.push(\`Bollinger Band Walk Downtrend (Squeeze Breakout)\`);
    }`;

code = code.replace(targetNoRsi, newNoRsi);

fs.writeFileSync('spotTAEngine.ts', code, 'utf8');
