// Kalshi request signing. Message = timestamp_ms + METHOD + path (path includes
// the /trade-api/v2 prefix and excludes the query string). RSA keys sign with
// RSA-PSS/SHA-256; Ed25519 keys (supported since 2026-09-24) sign directly.

import crypto from 'crypto';
import fs from 'fs';

export class KalshiSigner {
  private readonly key: crypto.KeyObject;

  constructor(readonly keyId: string, privateKeyPem: string) {
    this.key = crypto.createPrivateKey(privateKeyPem);
  }

  static fromFile(keyId: string, file: string): KalshiSigner {
    return new KalshiSigner(keyId, fs.readFileSync(file, 'utf8'));
  }

  headers(method: string, fullPath: string, nowMs = Date.now()): Record<string, string> {
    const ts = String(nowMs);
    const pathOnly = fullPath.split('?')[0];
    const msg = Buffer.from(ts + method.toUpperCase() + pathOnly);
    const sig = this.key.asymmetricKeyType === 'ed25519'
      ? crypto.sign(null, msg, this.key)
      : crypto.sign('sha256', msg, {
          key: this.key,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
        });
    return {
      'KALSHI-ACCESS-KEY': this.keyId,
      'KALSHI-ACCESS-TIMESTAMP': ts,
      'KALSHI-ACCESS-SIGNATURE': sig.toString('base64'),
    };
  }
}
