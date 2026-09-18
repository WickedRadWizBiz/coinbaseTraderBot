const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const target1m = `    tradeDbManager.updateTradeCounterfactualData(dbId, postExitTicks, snapshot1m).catch(() => {});
    } catch (e) {}
  }, 60000);
}`;

const new1mAnd10m = `    tradeDbManager.updateTradeCounterfactualData(dbId, postExitTicks, snapshot1m).catch(() => {});
    } catch (e) {}
  }, 60000);

  // 3. Non-blocking callback executed at timestamp_exit + 10 minutes
  setTimeout(async () => {
    try {
      const ctx = spotContexts[symbol];
      if (ctx && ctx.currentPrice) {
        tradeDbManager.updateTradeCounterfactual10m(dbId, ctx.currentPrice).catch(() => {});
      }
    } catch (e) {}
  }, 10 * 60 * 1000);
}`;

code = code.replace(target1m, new1mAnd10m);
fs.writeFileSync('server.ts', code, 'utf8');
console.log("Patched server.ts with 10m counterfactuals");
