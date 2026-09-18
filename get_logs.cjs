const http = require('http');

http.get('http://localhost:3000/api/market-context', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const logs = parsed.spotLogs || [];
      const tradeLogs = logs.filter(l => l.type === 'TRADE' || l.type === 'PROFIT' || l.type === 'ANALYZE');
      
      console.log("=== RECENT LOGS ===");
      tradeLogs.slice(0, 40).forEach(l => console.log(`[${l.type}] ${l.message}`));
      
    } catch (e) {
      console.error(e);
    }
  });
});
