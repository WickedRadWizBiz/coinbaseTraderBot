const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetObj = `    relativeVolume: currentSpotTA?.relativeVolume || 1,`;

const newObj = `    relativeVolume: currentSpotTA?.relativeVolume || 1,
    macdRatio: currentSpotTA?.macdRatio || 0,
    forceIndex: currentSpotTA?.forceIndex || 0,
    obvRoc: currentSpotTA?.obvRoc || 0,
    tnRsi: currentSpotTA?.tnRsi || 50,`;

code = code.replace(targetObj, newObj);
fs.writeFileSync('server.ts', code, 'utf8');
