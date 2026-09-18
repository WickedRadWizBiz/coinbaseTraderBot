const getBestOpenMarket = async (seriesTicker, label) => {
    try {
        const data = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${seriesTicker}&status=open`).then(r => r.json());
        const markets = data.markets || [];
        if (markets.length > 0) {
            markets.sort((a, b) => {
               const bidA = parseFloat(a.yes_bid_dollars) || 0;
               const askA = parseFloat(a.yes_ask_dollars) || 1;
               const distA = Math.abs(0.5 - (bidA + askA)/2);
               const bidB = parseFloat(b.yes_bid_dollars) || 0;
               const askB = parseFloat(b.yes_ask_dollars) || 1;
               const distB = Math.abs(0.5 - (bidB + askB)/2);
               return distA - distB;
            });
            const best = markets[0];
            let descriptiveLabel = label;
            if (best.yes_sub_title) descriptiveLabel = `${label} (YES if ${best.yes_sub_title})`;
            else if (best.subtitle) descriptiveLabel = `${label} (YES if ${best.subtitle})`;
            
            console.log(`Attached ${best.ticker} (${descriptiveLabel})`);
        }
    } catch(err) {
        console.error(err);
    }
}
getBestOpenMarket('KXBTC', 'BTC Hourly');
getBestOpenMarket('KXBTC15M', 'BTC 15-Min');
