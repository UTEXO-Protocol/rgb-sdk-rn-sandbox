import { BurnOperations, normalizeBurnRecord } from '@utexo/rgb-sdk-rn';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('app entry installs crypto before Router can evaluate wallet imports', () => {
  const pkg = JSON.parse(read('../package.json'));
  assert.equal(pkg.main, 'index.js');
  const context = vm.createContext({});
  let capturedCrypto;
  let registered = false;
  context.require = (name) => {
    if (name === './utils/runtime-polyfills') {
      vm.runInContext(read('../utils/runtime-polyfills.js'), context);
    } else if (name === 'react-native-get-random-values') {
      context.crypto = { getRandomValues: (bytes) => bytes };
    } else if (name === '@walletconnect/react-native-compat') {
      assert.equal(typeof context.crypto?.getRandomValues, 'function');
    } else if (name === 'buffer') {
      return { Buffer };
    } else if (name === 'expo-router/entry') {
      // Like noble v1, capture crypto at module evaluation, not first use.
      capturedCrypto = context.crypto;
      assert.equal(context.Buffer, Buffer);
      registered = true;
    } else if (!['os-browserify', 'path-browserify'].includes(name)) {
      throw new Error(`Unexpected bootstrap dependency: ${name}`);
    }
  };
  vm.runInContext(read('../index.js'), context);
  assert.equal(registered, true);
  assert.equal(typeof capturedCrypto?.getRandomValues, 'function');
});

function fixture(init, modules = {}) {
  const stats = { cores: 0, clients: 0, listeners: 0, seenCores: [] };
  const client = {
    on: () => { stats.listeners++; },
    getActiveSessions: () => ({}),
    core: { expirer: { on: () => { stats.listeners++; } } },
  };
  const context = vm.createContext({
    process: { env: { EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID: 'a'.repeat(32) } },
    setTimeout, clearTimeout, Error,
    require: (name) => {
      if (name === '@utexo/rgb-sdk-rn') return { BurnOperations, normalizeBurnRecord, ...modules[name] };
      if (Object.hasOwn(modules, name)) return modules[name];
      if (name === '@utexo/rgb-sdk-rn/webrgb') return { WEBRGB_READ_METHODS: ['enable', 'getInfo'] };
      if (name === '@walletconnect/core') return { Core: class { constructor() { stats.cores++; } } };
      if (name === '@reown/walletkit') return { WalletKit: { init: (options) => {
        stats.clients++;
        stats.seenCores.push(options.core);
        return init ? init(stats.clients, client) : Promise.resolve(client);
      } } };
      if (name === '@utexo/webrgb-walletconnect') return { createWalletConnectWallet: () => ({}) };
      return {};
    },
  });
  const cache = new Map();
  const loadFile = (filename, reload = false) => {
    if (!reload && cache.has(filename)) return cache.get(filename);
    const exports = {};
    cache.set(filename, exports);
    const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const require = name => {
      if (Object.hasOwn(modules, name)) return context.require(name);
      if (name.startsWith('.')) {
        // Keep env and faucet isolated from real local configuration/services.
        if (name === '../env' || name === '../mock-faucet') return context.require(name);
        return loadFile(path.resolve(path.dirname(filename), name + '.ts'));
      }
      return context.require(name);
    };
    vm.runInContext(`(function(exports, require) { ${source}\n})`, context)(exports, require);
    return exports;
  };
  const load = () => loadFile(fileURLToPath(new URL('../utils/wallet/service.ts', import.meta.url)), true).demoWallet;
  return { stats, load, client };
}

test('concurrent callers and module refresh share one initialized Core/client/listener set', async () => {
  let resolve;
  const pending = new Promise((yes) => { resolve = yes; });
  const { stats, load, client } = fixture(() => pending);
  const wallet = load();
  const first = wallet.connection.getClient();
  const second = wallet.connection.getClient();
  assert.equal(stats.cores, 1);
  assert.equal(stats.clients, 1);
  resolve(client);
  assert.equal(await first, client);
  assert.equal(await second, client);
  assert.equal(load(), wallet);
  assert.equal(await load().connection.getClient(), client);
  assert.deepEqual({ cores: stats.cores, clients: stats.clients, listeners: stats.listeners },
    { cores: 1, clients: 1, listeners: 2 });
});

test('a failed WalletKit initialization retries with the same Core', async () => {
  const { stats, load, client } = fixture((attempt, value) => attempt === 1
    ? Promise.reject(new Error('Relay unavailable')) : Promise.resolve(value));
  const wallet = load();
  await assert.rejects(wallet.connection.getClient(), /Relay unavailable/);
  assert.equal(await wallet.connection.getClient(), client);
  assert.equal(stats.cores, 1);
  assert.equal(stats.clients, 2);
  assert.equal(stats.seenCores[0], stats.seenCores[1]);
  assert.equal(stats.listeners, 2);
});

function nativeWalletFixture(initError, options = {}) {
  const calls = [];
  const native = { refreshes: 0, invoices: [], requests: [], responses: [] };
  const btc = {
    vanilla: { spendable: 92000, settled: 92000, future: 92000 },
    colored: { spendable: 4000, settled: 4000, future: 4000 },
  };
  const config = { network: 'regtest', unlockParams: { indexerUrl: 'mock-indexer' } };
  const modules = {
    '../env': { buildDemoWalletConfig: () => config },
    './provider': {
      createDemoRgbProvider: (_wallet, providerOptions) => Object.fromEntries(
        ['getAssetBalance', 'burnAsset'].map(method => [method, (...args) => providerOptions.run(method, args, async () => {
          native.requests.push(`rgb_${method}`);
          if (options.requestError) throw new Error(options.requestError);
          return { balance: 5 };
        })])
      ),
    },
    './connection-protocol': {
      isRgbSession: () => true,
      sessionOrigin: (url) => url,
    },
    'expo-secure-store': {
      getItemAsync: async () => JSON.stringify({ mnemonic: 'saved-test-mnemonic', password: 'saved-test-password' }),
      setItemAsync: async () => { calls.push('replaceCredentials'); },
    },
    'expo-file-system/legacy': {
      documentDirectory: 'file:///mock-wallet/',
      makeDirectoryAsync: async () => {},
    },
    '@react-native-async-storage/async-storage': { getItem: async () => null },
    '@utexo/rgb-sdk-rn': {
      createWallet: async () => { throw new Error('Must reuse saved keys'); },
      PasswordRLNSigner: class {
        constructor(password, mnemonic) {
          assert.equal(password, 'saved-test-password');
          assert.equal(mnemonic, 'saved-test-mnemonic');
        }
      },
      UTEXOWallet: class {
        async init() {
          calls.push('init');
          if (initError) throw new Error(initError);
        }
        async unlock(params) { assert.equal(params, config.unlockParams); calls.push('unlock'); }
        async getAddress() { return 'saved-btc-address'; }
        async getNodeInfo() { return { pubkey: 'saved-node-pubkey' }; }
        async getBfaCapabilities() { return { burn: false, consignment: false }; }
        async getBtcBalance() { return btc; }
        async listAssets() {
          if (options.readError?.()) throw new Error('Indexer unavailable');
          return { bfa: [{ assetId: 'rgb:test', ticker: 'TEST', name: 'Test asset', precision: 0,
            balance: { spendable: 5, settled: 5, future: 5 } }],
            nia: [{ assetId: 'rgb:nia', name: 'NIA test', precision: 0, balance: { spendable: 2, settled: 2, future: 2 } }], uda: null };
        }
        async listTransfers(assetId) {
          assert.ok(['rgb:test', 'rgb:nia'].includes(assetId), 'RLN requires a transfer filter');
          if (assetId === 'rgb:nia') return [];
          return [{ idx: 1, createdAt: 100 }, { idx: 2, createdAt: 200 }];
        }
        async refreshWallet() { native.refreshes++; await options.refresh?.(); }
        async blindReceive(params) {
          native.invoices.push(params);
          return { invoice: 'rgb:test-invoice', expirationTimestamp: 1234567890 };
        }
        async dispose() { calls.push('dispose'); }
      },
    },
  };
  const result = fixture(undefined, modules);
  const session = {
    topic: 'test-topic', expiry: Math.floor(Date.now() / 1000) + 3600,
    peer: { metadata: { url: 'https://test.example' } },
    namespaces: { rgb: { methods: ['rgb_getAssetBalance', 'rgb_burnAsset'] } },
  };
  result.client.getActiveSessions = () => ({ [session.topic]: session });
  return { ...result, calls, native, btc };
}

test('Open wallet unlocks the saved node after RLN reports it is already initialized', async () => {
  for (const message of ['Node has already been initialized', 'AlreadyInitialized', 'Node already initialized']) {
    const { load, calls } = nativeWalletFixture(message);
    const wallet = load();
    await Promise.all([wallet.start(), wallet.start()]);
    await wallet.start();
    assert.deepEqual(calls, ['init', 'unlock']);
    assert.equal(wallet.snapshot().ready, true);
    assert.equal(wallet.snapshot().error, '');
    assert.equal(wallet.snapshot().network, 'regtest');
    assert.equal(wallet.snapshot().address, 'saved-btc-address');
  }
});

test('Open wallet also unlocks after first-time node initialization succeeds', async () => {
  const { load, calls } = nativeWalletFixture();
  const wallet = load();
  await wallet.start();
  assert.deepEqual(calls, ['init', 'unlock']);
  assert.equal(wallet.snapshot().ready, true);
});

test('Open wallet reports unrelated init failures without attempting unlock', async () => {
  const { load, calls } = nativeWalletFixture('Database is unavailable');
  const wallet = load();
  await wallet.start();
  assert.deepEqual(calls, ['init', 'dispose']);
  assert.equal(wallet.snapshot().ready, false);
  assert.equal(wallet.snapshot().busy, false);
  assert.equal(wallet.snapshot().error, 'Database is unavailable');
});

test('opening loads BTC, BFA balances and newest transfers without generating invoices', async () => {
  const { load, native, btc } = nativeWalletFixture();
  const wallet = load();
  await wallet.start();
  const state = wallet.snapshot();
  assert.equal(state.btcBalance, btc);
  assert.equal(state.assets[0].schema, 'BFA');
  assert.equal(state.assets[0].balance.spendable, 5);
  assert.equal(state.transfers[0].idx, 2);
  assert.equal(state.transfers[0].assetId, 'rgb:test');
  assert.ok(state.updatedAt > 0);
  assert.equal(native.invoices.length, 0);
});

test('refresh is single-flight and blocks invoice allocation until native refresh completes', async () => {
  let resolve;
  const pending = new Promise((yes) => { resolve = yes; });
  const { load, native } = nativeWalletFixture(undefined, { refresh: () => pending });
  const wallet = load();
  await wallet.start();
  const refresh = wallet.refresh();
  await wallet.refresh();
  await wallet.generateInvoice({ amount: '5', durationMinutes: '60' });
  assert.equal(wallet.snapshot().busy, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(native.refreshes, 1);
  assert.equal(native.invoices.length, 0);
  resolve();
  await refresh;
  assert.equal(wallet.snapshot().busy, false);
  assert.equal(wallet.snapshot().refreshing, false);
});

test('failed refresh preserves the last complete balance snapshot and remains retryable', async () => {
  let broken = false;
  const { load } = nativeWalletFixture(undefined, { readError: () => broken });
  const wallet = load();
  await wallet.start();
  const original = wallet.snapshot();
  broken = true;
  await wallet.refresh();
  assert.equal(wallet.snapshot().assets, original.assets);
  assert.equal(wallet.snapshot().updatedAt, original.updatedAt);
  assert.equal(wallet.snapshot().error, 'Indexer unavailable');
  assert.equal(wallet.snapshot().busy, false);
  broken = false;
  await wallet.refresh();
  assert.equal(wallet.snapshot().error, '');
});

test('local invoices validate amount, asset and expiry before allocating a receive UTXO', async () => {
  const { load, native } = nativeWalletFixture();
  const wallet = load();
  await wallet.start();
  for (const amount of ['-1', '0', '1.5', '1e3', '9007199254740992']) {
    await wallet.generateInvoice({ amount, durationMinutes: '60' });
    assert.match(wallet.snapshot().error, /positive whole amount/);
  }
  await wallet.generateInvoice({ amount: '5', assetId: 'rgb:unknown', durationMinutes: '60' });
  assert.match(wallet.snapshot().error, /Select an asset/);
  await wallet.generateInvoice({ amount: '5', durationMinutes: '43201' });
  assert.match(wallet.snapshot().error, /expiry/);
  assert.equal(native.invoices.length, 0);
  await wallet.generateInvoice({ amount: '5', assetId: 'rgb:nia', durationMinutes: '60' });
  assert.deepEqual(JSON.parse(JSON.stringify(native.invoices[0])), {
    amount: 5, assetId: 'rgb:nia', durationSeconds: 3600, minConfirmations: 3,
  });
  assert.equal(wallet.snapshot().invoice.amount, 5);
  assert.equal(wallet.snapshot().invoice.source, 'Created on this device');
  await wallet.generateInvoice({ amount: '', durationMinutes: '15' });
  assert.equal(native.invoices[1].amount, undefined);
  assert.equal(native.invoices[1].assetId, undefined);
});

test('BFA receive preserves the asset constraint and never silently removes a requested amount', async () => {
  const { load, native } = nativeWalletFixture();
  const wallet = load();
  await wallet.start();
  await wallet.generateInvoice({ amount: '5', assetId: 'rgb:test', durationMinutes: '60' });
  assert.match(wallet.snapshot().error, /BFA build requires an open amount/);
  assert.equal(native.invoices.length, 0);
  await wallet.generateInvoice({ amount: '', assetId: 'rgb:test', durationMinutes: '60' });
  assert.equal(native.invoices[0].assetId, 'rgb:test');
  assert.equal(native.invoices[0].amount, undefined);
});

test('a generated invoice is retained if the follow-up balance read fails', async () => {
  let broken = false;
  const { load, native } = nativeWalletFixture(undefined, { readError: () => broken });
  const wallet = load();
  await wallet.start();
  broken = true;
  await wallet.generateInvoice({ amount: '5', durationMinutes: '60' });
  assert.equal(native.invoices.length, 1);
  assert.equal(wallet.snapshot().invoice.invoice, 'rgb:test-invoice');
  assert.match(wallet.snapshot().error, /Invoice created; balances could not refresh/);
});

const context = () => ({ origin: 'https://test.example', topic: 'test-topic', network: 'regtest',
  signal: new AbortController().signal, requestSignal: new AbortController().signal, assertAuthorized() {} });

test('website requests wait for a local refresh instead of overlapping native wallet work', async () => {
  let resolve;
  const pending = new Promise((yes) => { resolve = yes; });
  const { load, native } = nativeWalletFixture(undefined, { refresh: () => pending });
  const wallet = load();
  await wallet.start();
  const refresh = wallet.refresh();
  const request = wallet.provider(context()).getAssetBalance('rgb:test');
  assert.equal(native.requests.length, 0);
  resolve();
  await refresh;
  assert.equal((await request).balance, 5);
  assert.deepEqual(native.requests, ['rgb_getAssetBalance']);
  assert.equal(wallet.snapshot().activeRequest, '');
});

test('a failed website burn appears in wallet activity and is not retried automatically', async () => {
  const { load, native } = nativeWalletFixture(undefined, { requestError: 'Insufficient assets' });
  const wallet = load();
  await wallet.start();
  await assert.rejects(wallet.provider(context()).burnAsset({}), /Insufficient assets/);
  assert.deepEqual(native.requests, ['rgb_burnAsset']);
  assert.equal(wallet.snapshot().lastRequest.status, 'failed');
  assert.equal(wallet.snapshot().lastRequest.error, 'Insufficient assets');
  assert.equal(wallet.snapshot().activeRequest, '');
});

test('an expired request closes the wallet confirmation promptly', async () => {
  const { load } = nativeWalletFixture();
  const wallet = load();
  const controller = new AbortController();
  const prompt = wallet.confirm('Burn?', 'https://test.example', '5 units', Date.now() + 60000, controller.signal);
  assert.ok(wallet.snapshot().prompt);
  controller.abort();
  assert.equal(await prompt, false);
  assert.equal(wallet.snapshot().prompt, null);
});
