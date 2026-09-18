fetch('https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=5')
  .then(r => r.json())
  .then(openData => {
      if (openData && openData.markets) {
          for (const m of openData.markets) {
             console.log(m.ticker, m.yes_bid_dollars, m.yes_ask_dollars);
          }
      }
  });
