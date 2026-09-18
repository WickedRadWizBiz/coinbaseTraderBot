const fs = require('fs');
const crypto = require('crypto');
const dotenv = require('dotenv');
dotenv.config();

const keyId = process.env.KALSHI_API_KEY;
let pem = process.env.KALSHI_API_SECRET;
pem = pem.replace(/\\n/g, '\n');
const privateKey = crypto.createPrivateKey(pem);

const method = 'POST';
const path = '/trade-api/v2/portfolio/events/orders';
const timestamp = Date.now().toString();
const msg = timestamp + method + path;

const signature = crypto.sign(
  'sha256',
  Buffer.from(msg),
  {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  }
).toString('base64');

fetch('https://api.elections.kalshi.com' + path, {
  method,
  headers: {
    'Content-Type': 'application/json',
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature
  },
  body: JSON.stringify({
    ticker: "KXBTC15M-24SEP15-60000",
    action: "buy",
    side: "yes",
    count: 1
  })
}).then(res => res.text()).then(console.log);
