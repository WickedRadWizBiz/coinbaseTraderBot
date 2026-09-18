const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const tbmRegex = /const \{ labels, volatility, toxicAdverseSelectionCount \} = TripleBarrierEngine\.applyTripleBarrier\(concatenatedDataset\);\n      logMessages\.push\(`\[STEP 3\] Friction-Aware TBM ground truth labels generated \(EWMA Volatility: \$\{\(volatility \* 100\)\.toFixed\(2\)\}%[\s\S]*?`\);/;

const newTbm = `const { labels, volatility, toxicAdverseSelectionCount } = TripleBarrierEngine.applyTripleBarrier(concatenatedDataset);
      logMessages.push(\`[STEP 3] Friction-Aware TBM ground truth labels generated (EWMA Volatility: \${(volatility * 100).toFixed(2)}%, Taker Fee + Slippage: 0.50%, Toxic Adverse Selection Exits penalized: \${toxicAdverseSelectionCount}).\`);

      // Step 3.5: Counterfactual Regret Analysis (10m Memory)
      logMessages.push(\`[STEP 3.5] Injecting Counterfactual Regret Analysis into target labels based on 10-minute post-exit memory...\`);
      for (let i = 0; i < concatenatedDataset.length; i++) {
        const t = concatenatedDataset[i];
        if (t.post_exit_price_10m) {
           const side = t.primary_direction; // 1 for YES/LONG, -1 for NO/SHORT
           const exitPrice = t.exit_price;
           const post10m = t.post_exit_price_10m;
           
           // Calculate difference relative to exit price
           const priceDelta = (post10m - exitPrice) / exitPrice;
           const pnlDelta = side === 1 ? priceDelta : -priceDelta;
           
           if (labels[i] === 1 && pnlDelta > 0.05) {
               // Hit TP, but 10m later it was up another 5%! We left money on the table.
               // It's still a win, but we penalize it slightly so model learns to hold or trail.
               labels[i] = 0.8;
           } else if (labels[i] === 0 && pnlDelta > 0.03) {
               // Stopped out, but 10m later it rallied back to profit. Premature stop out!
               // This means the entry setup was actually valid, our stop was just too tight.
               // Boost the label so the neural net doesn't forget the pattern.
               labels[i] = 0.4;
           } else if (labels[i] === 1 && pnlDelta < -0.05) {
               // Hit TP, and 10m later it completely crashed. PERFECT EXIT.
               // Boost reward to reinforce this behavior.
               labels[i] = 1.0;
           }
        }
      }`;

code = code.replace(tbmRegex, newTbm);

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
console.log("Patched 10m counterfactuals into runRetrainingPipeline");
