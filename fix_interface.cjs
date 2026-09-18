const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const regex = /post_exit_snapshot_1m\?: any;/;
code = code.replace(regex, "post_exit_snapshot_1m?: any;\n  post_exit_price_10m?: number | null;");

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
console.log("Fixed ExpandedTradeLog interface");
