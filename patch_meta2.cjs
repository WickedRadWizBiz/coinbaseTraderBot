const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const interfaceTarget = `  smartTrailingDistance?: number;
  rsi: number;`;
const interfaceNew = `  smartTrailingDistance?: number;
  macroGoalProgress?: number;
  macroTimeElapsedHours?: number;
  macroGoalGrade?: number;
  rsi: number;`;
code = code.replace(interfaceTarget, interfaceNew);

const extractTarget = `      f.smartTrailingActive || 0, f.smartTrailingDistance || 0
    ];`;
const extractNew = `      f.smartTrailingActive || 0, f.smartTrailingDistance || 0,
      f.macroGoalProgress || 0, f.macroTimeElapsedHours || 0, f.macroGoalGrade || 0
    ];`;
code = code.replace(extractTarget, extractNew);

const inputShapeTarget = `inputShape: [5, 15],`;
const inputShapeNew = `inputShape: [5, 18],`;
code = code.replace(inputShapeTarget, inputShapeNew);

code = code.replace(/const D = 15;/g, "const D = 18;");
code = code.replace(/\[1, 5, 15\]/g, "[1, 5, 18]");

const weightTarget = `const timeDecayWeight = Math.pow(decayFactor, (N - 1) - i);`;
const weightNew = `// 5. Macro Goal Primary Objective Enforcement (12h / $100)
      const rawMacroGrade = X[i][17]; // macroGoalGrade is index 17
      const goalModifier = 1.0 + (rawMacroGrade || 0); // Boost weight for trades that align with the high-velocity macro goal
      const timeDecayWeight = Math.pow(decayFactor, (N - 1) - i) * goalModifier;`;
code = code.replace(weightTarget, weightNew);

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
