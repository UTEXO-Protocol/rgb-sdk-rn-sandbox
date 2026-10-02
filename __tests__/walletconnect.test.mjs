import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWalletConnectUri,
  sessionOrigin,
  isRgbSession,
} from '../utils/wallet/connection-protocol.ts';

const uri = `wc:${'a'.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;
test('scanner and pasted/deep-linked connections resolve to the same URI', () => {
  assert.equal(parseWalletConnectUri(` ${uri} `), uri);
  assert.equal(
    parseWalletConnectUri(`myapp://wallet?uri=${encodeURIComponent(uri)}`),
    uri
  );
});
test('reject payment invoices, malformed keys, expired QR and ambiguous parameters', () => {
  for (const input of [
    'rgb:invoice',
    'lnbc10invoice',
    'https://example.com',
    `https://example.com/?uri=${encodeURIComponent(uri)}`,
    `${uri}&expiryTimestamp=1&expiryTimestamp=2`,
    uri.replace('symKey=', 'invalid='),
    `${uri}&symKey=${'c'.repeat(64)}`,
    `${uri}&expiryTimestamp=1`,
    `${uri}&expiryTimestamp=${'9'.repeat(40)}`,
  ]) {
    assert.throws(() => parseWalletConnectUri(input));
  }
});
test('normalize the website identity and reject non-web origins or embedded credentials', () => {
  assert.equal(
    sessionOrigin('https://mint.example/demo-connect'),
    'https://mint.example'
  );
  assert.throws(() => sessionOrigin('javascript:alert(1)'));
  assert.throws(() => sessionOrigin('https://mint.example@evil.example'));
});
test('restored sessions must match the current wallet, network, methods and expiry', () => {
  const account = 'rgb:utexo:nodepubkey';
  const methods = ['rgb_getInfo', 'rgb_blindReceive'];
  const session = {
    sessionProperties: { webrgb: 'webrgb:1' },
    expiry: Date.now() / 1000 + 3600,
    namespaces: { rgb: { accounts: [account], methods } },
  };
  assert.equal(isRgbSession(session, account, methods), true);
  assert.equal(isRgbSession({ ...session, sessionProperties: undefined }, account, methods), false);
  assert.equal(isRgbSession(session, 'rgb:mainnet:nodepubkey', methods), false);
  assert.equal(
    isRgbSession(session, 'rgb:utexo:anotherwallet', methods),
    false
  );
  assert.equal(
    isRgbSession({ ...session, expiry: 1 }, account, methods),
    false
  );
  assert.equal(isRgbSession(session, account, ['rgb_getInfo']), false);
});
