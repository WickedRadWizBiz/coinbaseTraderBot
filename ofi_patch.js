const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetStr = `          if (bids.length > 0 && asks.length > 0) {
            targetCtx.currentPrice = (bids[0].price + asks[0].price) / 2;
            targetCtx.bids = bids;
            targetCtx.asks = asks;
          }`;

const replacementStr = `          if (bids.length > 0 && asks.length > 0) {
            const bestBid = bids[0].price;
            const bestBidSize = bids[0].size;
            const bestAsk = asks[0].price;
            const bestAskSize = asks[0].size;

            let e_b = 0;
            if (targetCtx.prevBestBid !== undefined) {
              if (bestBid > targetCtx.prevBestBid) e_b = bestBidSize;
              else if (bestBid === targetCtx.prevBestBid) e_b = bestBidSize - targetCtx.prevBidSize;
              else e_b = -targetCtx.prevBidSize;
            }

            let e_s = 0;
            if (targetCtx.prevBestAsk !== undefined) {
              if (bestAsk < targetCtx.prevBestAsk) e_s = bestAskSize;
              else if (bestAsk === targetCtx.prevBestAsk) e_s = bestAskSize - targetCtx.prevAskSize;
              else e_s = -targetCtx.prevAskSize;
            }

            const currentOFI = e_b - e_s;
            targetCtx.OFI = targetCtx.OFI !== undefined ? 0.8 * targetCtx.OFI + 0.2 * currentOFI : currentOFI;

            const imbalance = bestBidSize / (bestBidSize + bestAskSize || 1);
            targetCtx.microprice = bestBid * (1 - imbalance) + bestAsk * imbalance;

            targetCtx.currentPrice = targetCtx.microprice; // Use Microprice as core reference price!
            targetCtx.prevBestBid = bestBid;
            targetCtx.prevBidSize = bestBidSize;
            targetCtx.prevBestAsk = bestAsk;
            targetCtx.prevAskSize = bestAskSize;

            targetCtx.bids = bids;
            targetCtx.asks = asks;
          }`;

if (code.includes(targetStr)) {
  code = code.replace(targetStr, replacementStr);
  fs.writeFileSync('server.ts', code);
  console.log("OFI & Microprice injected.");
} else {
  console.error("Target string not found.");
}
