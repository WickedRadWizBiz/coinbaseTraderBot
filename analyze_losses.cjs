const fs = require('fs');
const http = require('http');

http.get('http://localhost:3000/api/market-context', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const logs = parsed.spotLogs || [];
      const trades = logs.filter(l => l.type === 'TRADE');
      
      let totalLoss = 0;
      let lossCount = 0;
      let ppoCount = 0;
      let graceCount = 0;
      let slCount = 0;
      let maxLoss = 0;
      let maxLossTrade = "";
      
      trades.forEach(l => {
         const match = l.message.match(/PnL: \$(-[0-9.]+)/);
         if (match) {
             const loss = parseFloat(match[1]);
             totalLoss += loss;
             lossCount++;
             if (loss < maxLoss) {
                 maxLoss = loss;
                 maxLossTrade = l.message;
             }
             if (l.message.includes('PPO AGENT EXIT')) ppoCount++;
             if (l.message.includes('Grace Period')) graceCount++;
             if (l.message.includes('SL')) slCount++;
         }
      });
      console.log(`Analyzed ${trades.length} TRADE logs (last 50 max stored in memory usually).`);
      console.log(`Losses found in logs: ${lossCount}, Total Loss Amount in logs: $${totalLoss.toFixed(2)}`);
      console.log(`Max single loss: $${maxLoss.toFixed(2)} -> ${maxLossTrade}`);
      console.log(`PPO Exits: ${ppoCount}, Grace Period SLs: ${graceCount}, Standard SLs: ${slCount}`);
      
    } catch (e) {
      console.error(e);
    }
  });
});
