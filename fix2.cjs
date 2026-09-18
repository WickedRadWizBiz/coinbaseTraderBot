const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const target = `        metaModelManager.runRetrainingPipeline().catch(err => {
          console.error("[BACKGROUND TRAIN ERROR]", err);
        });
      }
    }
  } catch (e) {
}`;

const rep = `        metaModelManager.runRetrainingPipeline().catch(err => {
          console.error("[BACKGROUND TRAIN ERROR]", err);
        });
    }
  } catch (e) {
}`;

code = code.replace(target, rep);
fs.writeFileSync('server.ts', code, 'utf8');
