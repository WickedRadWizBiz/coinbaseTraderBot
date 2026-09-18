const https = require('https');
https.get('https://api.elections.kalshi.com/trade-api/v2/events?limit=200', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        const events = JSON.parse(data).events || [];
        let sports = events.filter(e => e.category === 'Sports');
        let crypto = events.filter(e => e.category === 'Crypto');
        
        console.log("Sports:", sports.length, sports.slice(0,2).map(s => ({ticker: s.event_ticker, title: s.title})));
        console.log("Crypto:", crypto.length, crypto.slice(0,5).map(c => ({ticker: c.event_ticker, title: c.title, sub: c.sub_title, meta: c.product_metadata})));
    });
});
