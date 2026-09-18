const fs = require('fs');
const lines = fs.readFileSync('tradeDatabaseManager.ts', 'utf8').split('\n');

for (let i = 0; i < lines.length; i++) {
   if (lines[i].includes('|| null') && !lines[i].includes('post_exit_price_10m')) {
       lines[i] = `          post_exit_snapshot_1m: parsedMetrics.post_exit_snapshot_1m || null,
          post_exit_price_10m: parsedMetrics.post_exit_price_10m || null`;
   }
}

fs.writeFileSync('tradeDatabaseManager.ts', lines.join('\n'), 'utf8');
console.log("Fixed line 443");
