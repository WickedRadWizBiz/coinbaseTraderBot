const http = require('http');

http.get('http://localhost:3000/api/market-context', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const logs = parsed.spotLogs || [];
      const trades = logs.filter(l => l.type === 'TRADE' || l.type === 'PROFIT');
      
      console.log("=== RECENT TRADE LOGS ===");
      trades.slice(0, 50).forEach(l => console.log(`[${l.type}] ${l.message}`));
      
      console.log("\n=== CURRENT BALANCES ===");
      http.get('http://localhost:3000/api/balance', (res2) => {
          let bData = '';
          res2.on('data', c => bData += c);
          res2.on('end', () => console.log(bData));
      });
      
    } catch (e) {
      console.error(e);
    }
  });
});
