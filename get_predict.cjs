const fs = require('fs');
const lines = fs.readFileSync('metaLearningEngine.ts', 'utf8').split('\n');
let start = lines.findIndex(l => l.includes('public predictProba'));
let end = lines.findIndex((l, i) => i > start && l.startsWith('  }'));
console.log(lines.slice(start, end + 1).join('\n'));
