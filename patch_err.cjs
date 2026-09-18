const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const targetCatch = `      throw err;
    }
  }
}`;

const newCatch = `      console.error("[META LEARNING ENGINE] Pipeline failed error stack:", err);
      throw err;
    }
  }
}`;
code = code.replace(targetCatch, newCatch);
fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
