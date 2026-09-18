fetch(`https://api.elections.kalshi.com/trade-api/v2/events`)
  .then(r => r.json())
  .then(data => {
      const events = data.events || [];
      const m = events.map(e => e.event_ticker).filter(x => x).slice(0, 10);
      console.log("Events:", m);
  })
  .catch(console.error);
