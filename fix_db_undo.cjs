const fs = require('fs');
let code = fs.readFileSync('tradeDatabaseManager.ts', 'utf8');

const insertedStr = `post_exit_snapshot_1m: parsedMetrics.post_exit_snapshot_1m || null,
        post_exit_price_10m: parsedMetrics.post_exit_price_10m || null`;

code = code.split(insertedStr).join('');

fs.writeFileSync('tradeDatabaseManager.ts', code, 'utf8');
console.log("Restored original db manager");
