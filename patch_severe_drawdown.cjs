const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

code = code.replace(/const currentBlowoutCount = this\.currentModelBlowouts\.get\(strategyKey\) \|\| 0;/g, "const currentBlowoutCount = this.currentModelBlowouts.get(strategyKey) || 0;\n      const currentSevereDrawdownCount = this.currentModelSevereDrawdowns.get(strategyKey) || 0;");

code = code.replace(/if \(currentBlowoutCount > 0\) \{/g, `
      if (currentSevereDrawdownCount > 0 && currentBlowoutCount === 0) {
        logMessages.push(\`[DRAWDOWN PENALTY] Current active model recorded \${currentSevereDrawdownCount} severe 50% drawdown(s). Relaxing replacement criteria.\`);
        passedGatekeeper = passedGatekeeper || (dsrFiltered.observedSharpe > 0.3 && dsrFiltered.dsr >= 0.75);
      }
      
      if (currentBlowoutCount > 0) {`);

code = code.replace(/this\.currentModelBlowouts\.set\(strategyKey, 0\);/g, "this.currentModelBlowouts.set(strategyKey, 0);\n        this.currentModelSevereDrawdowns.set(strategyKey, 0);");

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
console.log('Updated severe drawdown gatekeeper penalty');
