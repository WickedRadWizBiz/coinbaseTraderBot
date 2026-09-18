fetch('https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=10')
  .then(r => r.json())
  .then(async openData => {
      if (openData && openData.markets) {
          for (const m of openData.markets) {
             const res = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${m.ticker}/orderbook`);
             const d = await res.json();
             console.log(m.ticker, JSON.stringify(d).substring(0, 100));
          }
      }
  });
