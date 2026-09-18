const fs = require('fs');

let content = fs.readFileSync('server.ts', 'utf-8');

const orderBookEndpoint = `
  // Get Mock Order Book Data
  app.get('/api/order-book/:product_id', (req, res) => {
    const basePrice = 64000 + (Math.random() * 100 - 50); // slight jitter
    const bias = cumulativeImbalance;
    
    let bids = [];
    for(let i=1; i<=30; i++) {
       bids.push({ price: basePrice - (i * 10), size: Math.max(0.1, Math.random() * 2 + (bias > 0 ? bias * 0.05 : 0)) });
    }
    let asks = [];
    for(let i=1; i<=30; i++) {
       asks.push({ price: basePrice + (i * 10), size: Math.max(0.1, Math.random() * 2 + (bias < 0 ? Math.abs(bias) * 0.05 : 0)) });
    }
    
    res.json({ bids, asks, currentPrice: basePrice });
  });
`;

content = content.replace('// Vite middleware', orderBookEndpoint + '\n  // Vite middleware');

fs.writeFileSync('server.ts', content);
