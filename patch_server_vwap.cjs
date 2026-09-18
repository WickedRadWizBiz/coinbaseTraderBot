const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetObj = `    stationarityFracDiff: currentSpotTA?.fractionalDiffValue || 0.0,
    hourOfDay: currentHour,`;

const newObj = `    stationarityFracDiff: currentSpotTA?.fractionalDiffValue || 0.0,
    anchoredVwapDistancePct: currentSpotTA?.anchoredVwapDistancePct || 0,
    anchoredVwapSlope: currentSpotTA?.anchoredVwapSlope || 0,
    relativeVolume: currentSpotTA?.relativeVolume || 1,
    hourOfDay: currentHour,`;

code = code.replace(targetObj, newObj);
fs.writeFileSync('server.ts', code, 'utf8');
