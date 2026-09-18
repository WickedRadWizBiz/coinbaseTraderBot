const fs = require('fs');

try {
  const data = JSON.parse(fs.readFileSync('bot_memory_db.json', 'utf8'));
  const trades = data.rawTrades || [];
  console.log(`Total trades in DB: ${trades.length}`);
  
  const losingTrades = trades.filter(t => !t.is_win);
  console.log(`Losing trades: ${losingTrades.length}`);
  
  let reasons = {};
  losingTrades.forEach(t => {
      let r = t.close_reason || "UNKNOWN";
      // group the emergency sl string
      if (r.includes("Emergency SL")) r = "Emergency SL";
      if (r.includes("PPO AGENT EXIT")) r = "PPO AGENT EXIT";
      if (r.includes("Volatility-Adjusted SL")) r = "Volatility-Adjusted SL";
      
      reasons[r] = (reasons[r] || 0) + 1;
  });
  
  console.log("=== LOSS REASONS ===");
  Object.entries(reasons).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => {
      console.log(`${v} times: ${k}`);
  });
  
  // Total lost
  let totalLoss = losingTrades.reduce((acc, t) => acc + (t.pnl_usd || 0), 0);
  console.log(`Total lost USD in DB: $${totalLoss.toFixed(2)}`);
  
  // List the top 10 largest losses
  losingTrades.sort((a,b) => (a.pnl_usd || 0) - (b.pnl_usd || 0));
  console.log("=== LARGEST LOSSES ===");
  losingTrades.slice(0, 10).forEach(t => {
      console.log(`Date: ${new Date(t.timestamp).toISOString()} | PnL: $${t.pnl_usd?.toFixed(2)} | Reason: ${t.close_reason} | Side: ${t.signal_side} | Size: ${t.size} | Pattern: ${t.pattern_type}`);
  });
} catch (e) {
  console.error(e);
}
