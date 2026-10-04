// Kalshi request signing. Message = timestamp_ms + METHOD + path (path includes
// the /trade-api/v2 prefix and excludes the query string). RSA keys sign with
// RSA-PSS/SHA-256; Ed25519 keys (supported since 2026-09-24) sign directly.

import crypto from 'crypto';
import fs from 'fs';

export class KalshiSigner {
  private readonly key: crypto.KeyObject;

  constructor(readonly keyId: string, privateKeyPem: string) {
    this.key = parsePrivateKey(privateKeyPem);
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

/**
 * Parse a private key that may have been damaged by copy-paste: Windows line endings, a byte-order
 * mark, literal "\n" sequences, indentation, a body joined onto one line, or the BEGIN/END lines
 * missing altogether. Throws a readable error (never containing key material) when nothing parses.
 */
export function parsePrivateKey(raw: string): crypto.KeyObject {
  const text = raw.replace(/^\uFEFF/, '').replace(/\\n/g, '\n').replace(/\r/g, '');
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  const label = m?.[1];
  const body = (m ? m[2] : text).replace(/[^A-Za-z0-9+/=]/g, '');
  const wrap = (l: string) => `-----BEGIN ${l}-----\n${body.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END ${l}-----\n`;
  const candidates = [text, ...(label ? [wrap(label)] : []), wrap('PRIVATE KEY'), wrap('RSA PRIVATE KEY'), wrap('EC PRIVATE KEY')];
  for (const c of candidates) {
    try { return crypto.createPrivateKey(c); } catch { /* next form */ }
  }
  const lines = text.split('\n').filter((l) => l.trim()).length;
  const hint = !body.length ? 'the file is empty'
    : /PUBLIC KEY/.test(text) ? 'it is a PUBLIC key; Kalshi needs the private key file you downloaded when creating the API key'
    : /ENCRYPTED/.test(text) ? 'it is password-protected; export it without a passphrase'
    : !m ? 'it has no -----BEGIN ... PRIVATE KEY----- / -----END ... PRIVATE KEY----- lines and the content is not a valid key'
    : 'the key content is incomplete or altered (often a partial copy-paste)';
  throw new Error(`Kalshi private key could not be read: ${hint} (${lines} non-empty lines, ${body.length} base64 characters; a full RSA key has about 1,600)`);
}
