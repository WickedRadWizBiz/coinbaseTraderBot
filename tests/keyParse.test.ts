// Private keys damaged by copy-paste still load; unusable files fail with a readable message.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { parsePrivateKey } from '../bot/kalshi/auth';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
const body = (pem: string) => pem.split('\n').filter((l) => l && !l.startsWith('-----')).join('');

test('parsePrivateKey: CRLF, BOM, literal \\n, indentation, one-line body, missing header lines', () => {
  const ok = (s: string) => assert.equal(parsePrivateKey(s).asymmetricKeyType, 'rsa');
  ok(pkcs8); ok(pkcs1);
  ok('﻿' + pkcs1.replace(/\n/g, '\r\n'));
  ok(pkcs1.replace(/\n/g, '\\n'));
  ok(pkcs1.split('\n').map((l) => '   ' + l).join('\n'));
  ok(`-----BEGIN RSA PRIVATE KEY----- ${body(pkcs1).replace(/(.{64})/g, '$1 ')} -----END RSA PRIVATE KEY-----`);
  ok(body(pkcs8));
  ok(body(pkcs1));
});

test('parsePrivateKey: truncated, public or empty files explain what is wrong without echoing the key', () => {
  const truncated = pkcs1.slice(0, 600) + '\n-----END RSA PRIVATE KEY-----\n';
  assert.throws(() => parsePrivateKey(truncated), (e: Error) => /incomplete or altered/.test(e.message) && !e.message.includes(body(pkcs1).slice(10, 40)));
  const pub = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) as string;
  assert.throws(() => parsePrivateKey(pub), /PUBLIC key/);
  assert.throws(() => parsePrivateKey(''), /empty/);
});
