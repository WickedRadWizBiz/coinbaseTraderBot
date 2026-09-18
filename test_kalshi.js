const symbol = 'INFLATION-24-11';
fetch(`https://api.elections.kalshi.com/trade-api/v2/markets/${symbol}/orderbook`)
  .then(r => r.json())
  .then(d => console.log(JSON.stringify(d).substring(0, 500)))
  .catch(console.error);
