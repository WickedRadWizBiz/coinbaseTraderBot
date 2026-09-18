const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const target = `app.post("/api/client-error", express.json(), (req, res) => { 
    console.log("[CLIENT ERROR REPORT]", req.body); 
    res.json({ ok: true }); 
  });`;
const replace = `app.post("/api/client-error", express.json(), (req, res) => { 
    console.log("[CLIENT ERROR REPORT]", req.body); 
    require('fs').appendFileSync('client_errors.log', JSON.stringify(req.body) + '\\n');
    res.json({ ok: true }); 
  });`;

code = code.replace(target, replace);
const target2 = `app.post("/api/client-error", express.json(), (req, res) => { 
    console.error("[CLIENT ERROR REPORT]", req.body); 
    res.json({ ok: true }); 
  });`;
const replace2 = `app.post("/api/client-error", express.json(), (req, res) => { 
    console.error("[CLIENT ERROR REPORT]", req.body); 
    require('fs').appendFileSync('client_errors.log', JSON.stringify(req.body) + '\\n');
    res.json({ ok: true }); 
  });`;
code = code.replace(target2, replace2);
fs.writeFileSync('server.ts', code, 'utf8');
