const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

// Patch 1: Rapid Scalp size calculation
code = code.replace(
  /let dynamicSize = Math.round\(50 \* settings.kellyMultiplier \* 1.50 \* assetMultiplier\);/,
  `const confRes = evaluateConfluenceFactorsCount(signalSide, spotTA, bidVol, askVol);
          const confCount = confRes.count;
          let targetDollarGoal = 20.0;
          if (confCount >= 3) targetDollarGoal = 50.0;
          else if (confCount === 2) targetDollarGoal = 30.0;
          const requiredCapital = targetDollarGoal / 0.15; // Aim for 15% TP to hit goal
          const requiredContracts = Math.round(requiredCapital / Math.max(0.01, entryPrice));
          let dynamicSize = Math.round(requiredContracts * settings.kellyMultiplier * 1.50 * assetMultiplier);`
);

// Patch 2: General candidate size calculation
code = code.replace(
  /let dynamicSize = Math.round\(50 \* \(pref.isFavored \? pref.shrunkKellyMultiplier : \(settings.kellyMultiplier \* pref.sizeMultiplier\)\)\);/,
  `const confCount = topCandidate.recCheck?.confluenceCount || 1;
        let targetDollarGoal = 20.0;
        if (confCount >= 3) {
          targetDollarGoal = 50.0;
        } else if (confCount === 2) {
          targetDollarGoal = 30.0;
        }
        const requiredCapital = targetDollarGoal / 0.15;
        const requiredContracts = Math.round(requiredCapital / Math.max(0.01, entryPrice));
        let dynamicSize = Math.round(requiredContracts * (pref.isFavored ? pref.shrunkKellyMultiplier : (settings.kellyMultiplier * pref.sizeMultiplier)));`
);

fs.writeFileSync('server.ts', code);
