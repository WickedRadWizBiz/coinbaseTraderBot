const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetEndpoint = `  res.json({
    winningStrategies: tradingBrain.winningStrategies,
    losingStrategies: tradingBrain.losingStrategies,
    tradeHistory: tradingBrain.tradeHistory,
    invalidationReviews: tradingBrain.invalidationReviews,
    extinctionList: Object.values(tradingBrain.extinctionList || {}),
    featureStats: tradingBrain.featureStats
  });`;
const newEndpoint = `  res.json({
    winningStrategies: tradingBrain.winningStrategies,
    losingStrategies: tradingBrain.losingStrategies,
    tradeHistory: tradingBrain.tradeHistory,
    invalidationReviews: tradingBrain.invalidationReviews,
    extinctionList: Object.values(tradingBrain.extinctionList || {}),
    featureStats: tradingBrain.featureStats,
    smartTrailingStats: tradingBrain.smartTrailingStats
  });`;
code = code.replace(targetEndpoint, newEndpoint);

fs.writeFileSync('server.ts', code, 'utf8');
