const fs = require('fs');

try {
  const data = JSON.parse(fs.readFileSync('bot_memory_db.json', 'utf8'));
  const trades = data.rawTrades || [];
  
  let losingTrades = [];
  trades.forEach(t => {
     if (t.raw_metrics) {
         try {
             const metrics = JSON.parse(t.raw_metrics);
             if (metrics.pnlUsd < 0) {
                 losingTrades.push(metrics);
             }
         } catch(e){}
     }
  });
  
  let reasons = {};
  losingTrades.forEach(m => {
      let r = m.closeReason || "UNKNOWN";
      if (r.includes("Emergency SL")) r = "Emergency SL";
      if (r.includes("PPO AGENT EXIT")) r = "PPO AGENT EXIT";
      if (r.includes("Volatility-Adjusted SL")) r = "Volatility-Adjusted SL";
      if (r.includes("Stop Loss")) r = "Standard Stop Loss";
      reasons[r] = (reasons[r] || 0) + 1;
  });
  
  console.log("=== LOSS REASONS ===");
  Object.entries(reasons).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => {
      console.log(`${v} times: ${k}`);
  });
  
  let totalLoss = losingTrades.reduce((acc, m) => acc + m.pnlUsd, 0);
  console.log(`Total lost USD in DB: $${totalLoss.toFixed(2)}`);
  
  losingTrades.sort((a,b) => a.pnlUsd - b.pnlUsd);
  console.log("=== LARGEST LOSSES ===");
  losingTrades.slice(0, 15).forEach(m => {
      console.log(`Date: ${m.timestamp} | PnL: $${m.pnlUsd?.toFixed(2)} (${m.pnlPct}%) | Reason: ${m.closeReason} | Side: ${m.side}`);
  });
} catch (e) {
  console.error(e);
}
