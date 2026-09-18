const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const target1 = `metaModelManager.runRetrainingPipeline(strategyKey).catch(e => console.error("Retraining err:", e));
           }
       }
    }`;
const new1 = `metaModelManager.runRetrainingPipeline(strategyKey).catch(e => console.error("Retraining err:", e));
       }
    }`;
code = code.replace(target1, new1);

const target2 = `metaModelManager.runRetrainingPipeline().catch(err => {
          console.error("[BACKGROUND TRAIN ERROR]", err);
        });
      }
    }
  } catch (e) {
}`;
const new2 = `metaModelManager.runRetrainingPipeline().catch(err => {
          console.error("[BACKGROUND TRAIN ERROR]", err);
        });
    }
  } catch (e) {
}`;
code = code.replace(target2, new2);

fs.writeFileSync('server.ts', code, 'utf8');
