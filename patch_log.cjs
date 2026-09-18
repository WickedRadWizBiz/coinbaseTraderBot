const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

const target = `    this.isTraining = true;
    const jobId = crypto.randomUUID();`;
    
const newCode = `    this.isTraining = true;
    const jobId = crypto.randomUUID();
    console.log("[DEBUG] runRetrainingPipeline STARTED with jobId:", jobId);`;
    
code = code.replace(target, newCode);
fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
