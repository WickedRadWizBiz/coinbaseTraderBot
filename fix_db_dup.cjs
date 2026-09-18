const fs = require('fs');
let code = fs.readFileSync('tradeDatabaseManager.ts', 'utf8');

const regex = /  async updateTradeCounterfactual10m\(dbId: number, price10m: number\): Promise<boolean> \{\n    const row = this\.rawTrades\.find\(r => r\.id === dbId\);\n    if \(!row\) return false;\n    try \{\n      let parsed: any = \{\};\n      if \(row\.raw_metrics\) parsed = JSON\.parse\(row\.raw_metrics\);\n      parsed\.post_exit_price_10m = price10m;\n      row\.raw_metrics = JSON\.stringify\(parsed\);\n      this\.triggerSave\(\);\n      return true;\n    \} catch \(e\) \{\n      return false;\n    \}\n  \}\n\n/;

code = code.replace(regex, "");

fs.writeFileSync('tradeDatabaseManager.ts', code, 'utf8');
console.log("Removed duplicate updateTradeCounterfactual10m");
