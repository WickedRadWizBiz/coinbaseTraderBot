const fs = require('fs');
let code = fs.readFileSync('tradeDatabaseManager.ts', 'utf8');

const decodeTarget = "post_exit_snapshot_1m: parsedMetrics.post_exit_snapshot_1m || null";
const decodeNew = `post_exit_snapshot_1m: parsedMetrics.post_exit_snapshot_1m || null,
        post_exit_price_10m: parsedMetrics.post_exit_price_10m || null`;
code = code.split(decodeTarget).join(decodeNew);

const targetMethod = `async updateTradeCounterfactualData(
    dbId: number,
    postExitTicks20s?: any[],
    postExitSnapshot1m?: any
  ): Promise<boolean> {`;

const newMethod = `async updateTradeCounterfactual10m(dbId: number, price10m: number): Promise<boolean> {
    const row = this.rawTrades.find(r => r.id === dbId);
    if (!row) return false;
    try {
      let parsed: any = {};
      if (row.raw_metrics) parsed = JSON.parse(row.raw_metrics);
      parsed.post_exit_price_10m = price10m;
      row.raw_metrics = JSON.stringify(parsed);
      this.triggerSave();
      return true;
    } catch (e) {
      return false;
    }
  }

  async updateTradeCounterfactualData(
    dbId: number,
    postExitTicks20s?: any[],
    postExitSnapshot1m?: any
  ): Promise<boolean> {`;

code = code.split(targetMethod).join(newMethod);

fs.writeFileSync('tradeDatabaseManager.ts', code, 'utf8');
console.log("Successfully applied 10m update to db manager.");
