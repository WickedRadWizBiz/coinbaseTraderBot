const http = require('http');

http.get('http://localhost:3000/api/market-context', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const logs = parsed.spotLogs || [];
      const tradeLogs = logs.filter(l => l.type === 'TRADE' || l.type === 'PROFIT' || l.type === 'ANALYZE').slice(0, 100);
      
      console.log("=== RECENT LOGS ===");
      tradeLogs.forEach(l => console.log(`[${l.type}] ${l.time}: ${l.message}`));
      
      // Let's also check if there are other stats we can glean
    } catch (e) {
      console.error(e);
    }
  });
});
