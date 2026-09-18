const fs = require('fs');
let code = fs.readFileSync('tradeDatabaseManager.ts', 'utf8');

const regex1 = /          post_exit_snapshot_1m: parsedMetrics\.post_exit_snapshot_1m \|\| null,\n          post_exit_price_10m: parsedMetrics\.post_exit_price_10m \|\| null\n          maxAdverseExcursion/;

code = code.replace(regex1, "          entry_features: parsedMetrics.entryFeatures || parsedMetrics.entry_features || null,\n          maxAdverseExcursion");

fs.writeFileSync('tradeDatabaseManager.ts', code, 'utf8');
console.log("Fixed mess");
