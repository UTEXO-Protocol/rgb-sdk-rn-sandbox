import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { base64 } from '@scure/base';
import * as webrgb from '@utexo/rgb-sdk-rn/webrgb';
import { assertRuntime } from '../node_modules/@utexo/rgb-sdk-rn/lib/module/wallet/rgb-lib/native.js';

function load(relative, modules, env = {}) {
  const source = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(`(function(exports, require) {${source}\n})`, { process: { env }, URL, URLSearchParams, AbortController, setTimeout, clearTimeout })(exports, name => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected dependency ${name}`);
    return modules[name];
  });
  return exports;
}
function fixture({ failOnline = false } = {}) {
  const values = new Map([['utexo-demo-wallet-v1-utexo', 'OLD KEY MUST NOT BE READ']]);
  const events = [];
  class Wallet {
    constructor(options) { this.options = options; events.push('construct'); }
    async init() { events.push('init'); assert.equal(await this.options.keys(), 'NEW TEST KEY'); }
    async goOnline(config) { this.config = config; if (failOnline) throw new Error('Indexer unavailable'); }
    async getWalletIdentity() { return { id: 'stable-public-id' }; }
    async getAddress() { return 'tb1p-test'; }
    async reinit(config) { this.config = config; events.push('reinit'); }
    async dispose() { events.push('dispose'); }
  }
  const node = load('../utils/wallet/node.ts', {
    '@utexo/rgb-sdk-rn': { UTEXOWallet: Wallet, generateKeys: async network => { assert.equal(network, 'utexo'); events.push('generate'); return { mnemonic: 'NEW TEST KEY' }; } },
    'expo-file-system/legacy': { documentDirectory: 'file:///data/user/0/com.utexo.sandbox.bfadevnext/files/' },
    'expo-secure-store': {
      getItemAsync: async key => { assert.notEqual(key, 'utexo-demo-wallet-v1-utexo'); return values.get(key) ?? null; },
      setItemAsync: async (key, value) => { events.push('save'); values.set(key, value); },
    },
  });
  return { node, values, events };
}
const config = { network: 'utexo', unlockParams: { indexer: { type: 'esplora', url: 'https://dev.esplora-01.mint.utexo.com' }, proxyEndpoint: 'rpcs://dev.rgb-proxy.utexo.com/json-rpc', evmMintLockBlocks: { '42161': { min: 1200, max: 28800 } }, evmRpcUrls: { '42161': 'https://arb1.arbitrum.io/rpc' } } };

test('new wallet saves a separate key before native initialization and reuses it after restart', async () => {
  const { node, events, values } = fixture();
  const first = await node.openSavedWallet(config);
  assert.equal(first.wallet.options.protocol, 'RGB_L1');
  assert.equal(first.wallet.options.params.storageDirPath, '/data/user/0/com.utexo.sandbox.bfadevnext/files/rgb-l1-devnext-v6-5010eef/utexo');
  assert.equal(first.wallet.config, config.unlockParams);
  assert.ok(events.indexOf('save') < events.indexOf('init'));
  const second = await node.openSavedWallet(config);
  assert.equal(first.account, second.account);
  assert.equal(events.filter(x => x === 'generate').length, 1);
  assert.equal(values.get('utexo-demo-wallet-v1-utexo'), 'OLD KEY MUST NOT BE READ');
  const reopened = await node.openSavedWallet(config, second.wallet);
  assert.equal(reopened.wallet, second.wallet);
  assert.equal(reopened.account, first.account);
  assert.equal(events.at(-1), 'reinit');
});
test('RPC diagnostics distinguish rejected HTTP, non-JSON and valid chain responses without copying response secrets', async () => {
  const rpc = load('../utils/wallet/rpc-diagnostics.ts', {});
  const requests = [];
  const responses = [new Response('Forbidden secret-body', { status: 403, headers: { 'content-type': 'text/plain' } }),
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xa4b1' }), { status: 200, headers: { 'content-type': 'application/json' } })];
  const report = await rpc.checkEvmRpc('https://example.test/rpc', async (url, options) => {
    requests.push(JSON.parse(options.body));
    assert.equal(options.credentials, 'omit');
    assert.equal(options.method, 'POST');
    return responses.shift();
  });
  assert.equal(requests[0].method, 'eth_chainId');
  assert.equal(requests[0].params, null);
  assert.equal(requests[1].params.length, 0);
  assert.equal(report.checks[0].status, 403);
  assert.equal(report.checks[0].responseFormat, 'Non-JSON');
  assert.equal(report.checks[1].expectedChain, true);
  assert.ok(!JSON.stringify(report).includes('secret-body'));
});
test('RPC diagnostics preserve HTTP success with an HTML body as a decoding failure', async () => {
  const rpc = load('../utils/wallet/rpc-diagnostics.ts', {});
  const report = await rpc.checkEvmRpc('https://example.test/rpc', async () => new Response('<html>Sign in</html>', { status: 200 }));
  assert.equal(report.checks[0].status, 200);
  assert.equal(report.checks[0].responseFormat, 'HTML/XML');
  assert.equal(report.checks[0].expectedChain, false);
});
test('network failure preserves the new mnemonic and releases the native handle', async () => {
  const { node, events, values } = fixture({ failOnline: true });
  await assert.rejects(node.openSavedWallet(config), /Indexer unavailable/);
  assert.equal(events.at(-1), 'dispose');
  assert.equal(values.get('utexo-devnext-v6-5010eef-wallet-v1-utexo'), 'NEW TEST KEY');
  assert.equal(values.get('utexo-demo-wallet-v1-utexo'), 'OLD KEY MUST NOT BE READ');
});
test('Dev configuration does not silently open staging or regtest', () => {
  const env = load('../utils/env.ts', {});
  const actual = env.buildDemoWalletConfig();
  assert.equal(JSON.stringify(actual), JSON.stringify(config));
  assert.equal(env.isDemoWalletNetwork('regtest'), false);
  assert.throws(() => env.buildDemoWalletConfig('regtest'), /new Dev environment/);
});
test('runtime guard accepts the pinned runtime and rejects old RGB-lib or bridge version', () => {
  const runtime = { version: '0.3.0-beta.7-upstream-dev-bfa.6-bfa.devnext.1', sourceRevision: '5010eefa355beb9c42a4c1b69883f7651241a111', bridgeVersion: 5 };
  assert.doesNotThrow(() => assertRuntime(runtime));
  assert.throws(() => assertRuntime({ ...runtime, sourceRevision: '3f571ac58909400046d69143ebb535f4da1f4d42' }), /do not match/);
  assert.throws(() => assertRuntime({ ...runtime, bridgeVersion: 3 }), /do not match/);
});
test('WalletConnect deep link is directed to the independent Dev Next app', () => {
  const protocol = load('../utils/wallet/connection-protocol.ts', {});
  const uri = `wc:${'a'.repeat(64)}@2?relay-protocol=irn&symKey=${'b'.repeat(64)}`;
  assert.equal(protocol.parseWalletConnectUri(`utexobfadevnext://wallet?uri=${encodeURIComponent(uri)}`), uri);
  assert.throws(() => protocol.parseWalletConnectUri(`utexobfalocal://wallet?uri=${encodeURIComponent(uri)}`));
  const metadata = readFileSync(new URL('../utils/wallet/connection.ts', import.meta.url), 'utf8');
  assert.ok(metadata.includes("native: 'utexobfadevnext://wallet'"));
});
test('combined burn export preserves proof bytes and binds the original payout network and recipient', () => {
  const destination = load('../utils/wallet/burn-destination.ts', { '@utexo/rgb-sdk-rn/webrgb': webrgb });
  const pack = load('../utils/wallet/burn-package.ts', { '@scure/base': { base64 }, '@utexo/rgb-sdk-rn/webrgb': webrgb });
  const address = '0x5507e68BB23D99F06C9C6519B29Afa3A371bD3b7';
  const polygon = destination.localBfaBurnDestination({ chainId: 'eip155:137', address });
  const ethereum = destination.localBfaBurnDestination({ chainId: 'eip155:1', address });
  assert.notEqual(webrgb.burnDestinationHash(polygon), webrgb.burnDestinationHash(ethereum));
  const bytes = Uint8Array.from([0x52, 0x47, 0x42, 0, 0x54, 0x46, 0x52, 1, 2, 3]);
  const data = base64.encode(bytes);
  const parsed = JSON.parse(pack.createBurnPackage(data, polygon));
  assert.equal(parsed.consignment.data, data);
  assert.equal(parsed.consignment.byteLength, bytes.length);
  assert.equal(webrgb.burnDestinationHash(parsed.burnDestination), webrgb.burnDestinationHash(polygon));
  assert.throws(() => pack.createBurnPackage(base64.encode(Uint8Array.of(1, 2)), polygon), /Invalid RGB/);
  assert.throws(() => destination.localBfaBurnDestination({ chainId: 'eip155:999999', address }));
});
