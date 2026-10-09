import { BurnOperations, normalizeBurnRecord } from '@utexo/rgb-sdk-rn';
import { encodeEvmBurnRecipient } from '@utexo/rgb-sdk-rn/webrgb';
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
  const stats = { cores: 0, clients: 0, listeners: 0, seenCores: [], transports: [], disposedTransports: 0 };
  const client = {
    on: () => { stats.listeners++; },
    sessions: {},
    getActiveSessions: () => client.sessions,
    disconnectSession: async ({ topic }) => { delete client.sessions[topic]; },
    core: { expirer: { on: () => { stats.listeners++; } } },
  };
  const context = vm.createContext({
    process: { env: { EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID: 'a'.repeat(32) } },
    setTimeout, clearTimeout, Error,
    require: (name) => {
      if (name === '@utexo/rgb-sdk-rn') return { BurnOperations, normalizeBurnRecord, ...modules[name] };
      if (Object.hasOwn(modules, name)) return modules[name];
      if (name === '@utexo/rgb-sdk-rn/webrgb') return { WEBRGB_READ_METHODS: ['enable', 'getInfo'], encodeEvmBurnRecipient };
      if (name === '@walletconnect/core') return { Core: class { constructor() { stats.cores++; } } };
      if (name === '@reown/walletkit') return { WalletKit: { init: (options) => {
        stats.clients++;
        stats.seenCores.push(options.core);
        return init ? init(stats.clients, client) : Promise.resolve(client);
      } } };
      if (name === '@utexo/webrgb-walletconnect') return { createWalletConnectWallet: (options) => {
        stats.transports.push(options);
        return { dispose: () => { stats.disposedTransports++; }, pair: async () => {} };
      } };
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
  const loadBurn = () => loadFile(fileURLToPath(new URL('../utils/wallet/burn.ts', import.meta.url)));
  return { stats, load, client, loadBurn };
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
  const native = { refreshes: 0, invoices: [], requests: [], responses: [], nodes: [], keys: [], storageReads: [], lifecycle: [], burns: [] };
  const storage = new Map(options.savedNetwork ? [['utexo-demo-wallet-network-v1', options.savedNetwork]] : []);
  const btc = {
    vanilla: { spendable: 92000, settled: 92000, future: 92000 },
    colored: { spendable: 4000, settled: 4000, future: 4000 },
  };
  const configs = Object.fromEntries(['utexo', 'regtest'].map(network => [network,
    { network, unlockParams: { indexerUrl: `mock-${network}-indexer`, ...(options.burnAvailable ? { ethRpcUrl: 'mock-rpc' } : {}) } }]));
  const modules = {
    '../env': {
      buildDemoWalletConfig: (network = 'utexo') => configs[network],
      isDemoWalletNetwork: (value) => ['utexo', 'regtest'].includes(value),
    },
    '../mock-faucet': { mockFaucetEnabled: () => false },
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
      getItemAsync: async (key) => {
        native.keys.push(key);
        return JSON.stringify({ mnemonic: 'saved-test-mnemonic', password: 'saved-test-password' });
      },
      setItemAsync: async () => { calls.push('replaceCredentials'); },
    },
    'expo-file-system/legacy': {
      documentDirectory: 'file:///mock-wallet/',
      makeDirectoryAsync: async () => {},
    },
    '@react-native-async-storage/async-storage': {
      getItem: async (key) => {
        native.storageReads.push(key);
        if (key === 'utexo-demo-wallet-network-v1') await options.preference?.();
        return storage.get(key) ?? null;
      },
      setItem: async (key, value) => {
        if (options.saveError?.()) throw new Error('Storage is unavailable');
        storage.set(key, value);
      },
    },
    '@utexo/rgb-sdk-rn': {
      createWallet: async () => { throw new Error('Must reuse saved keys'); },
      PasswordRLNSigner: class {
        constructor(password, mnemonic) {
          assert.equal(password, 'saved-test-password');
          assert.equal(mnemonic, 'saved-test-mnemonic');
        }
      },
      UTEXOWallet: class {
        constructor(params) { this.network = params.network; native.nodes.push(params); }
        async init() {
          calls.push('init');
          if (initError) throw new Error(initError);
        }
        async unlock(params) {
          assert.equal(params, configs[this.network].unlockParams);
          calls.push('unlock'); native.lifecycle.push(`unlock:${this.network}`);
          await options.unlock?.(this.network);
        }
        async shutdown() {
          if (options.shutdownError?.()) throw new Error('Could not stop node');
          calls.push('shutdown'); native.lifecycle.push(`shutdown:${this.network}`);
        }
        async reinit(params) {
          assert.equal(params, configs[this.network].unlockParams);
          calls.push('reinit'); native.lifecycle.push(`reinit:${this.network}`);
          await options.unlock?.(this.network);
        }
        async getAddress() { return this.network === 'utexo' ? 'saved-btc-address' : 'saved-regtest-address'; }
        async getNodeInfo() { return { pubkey: 'saved-node-pubkey' }; }
        async getBfaCapabilities() { return { burn: !!options.burnAvailable, consignment: !!options.burnAvailable }; }
        async getAssetBalance() { return { spendable: options.available?.() ?? 5 }; }
        async burn(params) {
          const journal = JSON.parse(storage.get(`utexo-burn-journal-v1:rgb:${this.network}:saved-node-pubkey`));
          assert.equal(journal.at(-1).state, 'pending', 'Persist before invoking native burn');
          native.burns.push(params);
          await options.burn?.(params);
          return { txid: 'ab'.repeat(32), batchTransferIdx: 3 };
        }
        async getBtcBalance() { return btc; }
        async listAssets() {
          if (options.readError?.(this.network)) throw new Error('Indexer unavailable');
          return { bfa: [{ assetId: 'rgb:test', ticker: 'TEST', name: 'Test asset', precision: options.precision ?? 0,
            balance: { spendable: options.available?.() ?? 5, settled: 5, future: 5 } }],
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
  result.client.sessions = { [session.topic]: session };
  return { ...result, calls, native, btc, storage };
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
    assert.equal(wallet.snapshot().network, 'utexo');
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

const context = () => ({ origin: 'https://test.example', topic: 'test-topic', network: 'utexo',
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

test('Wallet tab defaults to Utexo signet even when a mock faucet and network override exist', () => {
  const env = { EXPO_PUBLIC_DEMO_MOCK_FAUCET_URL: 'http://192.168.1.10:31020', EXPO_PUBLIC_UTEXO_NETWORK: 'regtest' };
  const exports = {};
  const source = ts.transpileModule(read('../utils/env.ts'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    exports, process: { env }, URL, Error,
    require: name => {
      assert.equal(name, 'react-native');
      return { Platform: { OS: 'ios' } };
    },
  });
  const signet = exports.buildDemoWalletConfig();
  assert.equal(signet.network, 'utexo');
  assert.equal(signet.unlockParams.indexerUrl, 'https://esplora-api.utexo.com');
  assert.equal(signet.unlockParams.proxyEndpoint, 'rpcs://rgb-proxy.utexo.com/json-rpc');
  const local = exports.buildDemoWalletConfig('regtest');
  assert.equal(local.network, 'regtest');
  assert.equal(local.unlockParams.indexerUrl, '192.168.1.10:51211');
  assert.equal(local.unlockParams.proxyEndpoint, 'rpc://192.168.1.10:31210/json-rpc');
  assert.equal(local.unlockParams.ethRpcUrl, 'http://192.168.1.10:31020/rpc');
  env.EXPO_PUBLIC_DEMO_MOCK_FAUCET_URL = 'invalid';
  assert.equal(exports.buildDemoWalletConfig().network, 'utexo');
  assert.throws(() => exports.buildDemoWalletConfig('regtest'));
  delete env.EXPO_PUBLIC_DEMO_MOCK_FAUCET_URL;
  env.EXPO_PUBLIC_RLN_INDEXER_URL = 'local-indexer:50001';
  env.EXPO_PUBLIC_RLN_PROXY_ENDPOINT = 'rpc://local-proxy:3000/json-rpc';
  assert.equal(exports.buildDemoWalletConfig('regtest').unlockParams.indexerUrl, 'local-indexer:50001');
  assert.equal(exports.buildDemoWalletConfig('regtest').unlockParams.proxyEndpoint, 'rpc://local-proxy:3000/json-rpc');
  assert.throws(() => exports.buildDemoWalletConfig('mainnet'), /Unsupported/);
});

test('selecting a network before opening only saves a local preference', async () => {
  const { load, calls, stats, storage } = nativeWalletFixture();
  const wallet = load();
  await wallet.initialize();
  assert.equal(wallet.snapshot().network, 'utexo');
  assert.equal(wallet.snapshot().networkLoaded, true);
  await wallet.selectNetwork('regtest');
  assert.equal(wallet.snapshot().network, 'regtest');
  assert.equal(wallet.snapshot().ready, false);
  assert.equal(storage.get('utexo-demo-wallet-network-v1'), 'regtest');
  assert.deepEqual(calls, []);
  assert.equal(stats.cores, 0);
  assert.equal(stats.clients, 0);
  await wallet.start();
  assert.equal(wallet.snapshot().address, 'saved-regtest-address');
});

test('opening waits for the persisted network before creating a native wallet', async () => {
  let resolve;
  const pending = new Promise(yes => { resolve = yes; });
  const { load, native } = nativeWalletFixture(undefined, { savedNetwork: 'regtest', preference: () => pending });
  const wallet = load();
  const opening = wallet.start();
  assert.equal(native.nodes.length, 0);
  resolve();
  await opening;
  assert.equal(wallet.snapshot().network, 'regtest');
  assert.equal(native.nodes[0].network, 'regtest');
  assert.deepEqual(native.keys, ['utexo-demo-wallet-v1-regtest']);
});

test('switching clears old data/sessions, separates storage, and restarts saved nodes on return', async () => {
  const { load, native, stats, client, storage } = nativeWalletFixture();
  const wallet = load();
  await wallet.start();
  await wallet.generateInvoice({ amount: '5', durationMinutes: '60' });
  const oldProvider = wallet.provider(context());
  await wallet.selectNetwork('regtest');
  assert.equal(wallet.snapshot().error, '');
  assert.equal(wallet.snapshot().ready, true);
  assert.equal(wallet.snapshot().network, 'regtest');
  assert.equal(wallet.snapshot().invoice, null);
  assert.equal(wallet.snapshot().lastRequest, null);
  assert.equal(wallet.snapshot().sessions.length, 0);
  assert.equal(Object.keys(client.sessions).length, 0);
  assert.equal(stats.disposedTransports, 1);
  assert.equal(stats.transports.at(-1).network, 'regtest');
  assert.equal(stats.cores, 1);
  assert.equal(stats.clients, 1);
  assert.equal(stats.listeners, 2);
  assert.deepEqual(native.keys, ['utexo-demo-wallet-v1-utexo', 'utexo-demo-wallet-v1-regtest']);
  assert.equal(native.nodes[0].storageDirPath, '/mock-wallet/wallet-connect-v1/utexo');
  assert.equal(native.nodes[1].storageDirPath, '/mock-wallet/wallet-connect-v1/regtest');
  assert.ok(native.storageReads.includes('utexo-burn-journal-v1:rgb:utexo:saved-node-pubkey'));
  assert.ok(native.storageReads.includes('utexo-burn-journal-v1:rgb:regtest:saved-node-pubkey'));
  await wallet.selectNetwork('utexo');
  assert.equal(wallet.snapshot().address, 'saved-btc-address');
  assert.equal(storage.get('utexo-demo-wallet-network-v1'), 'utexo');
  assert.equal(native.nodes.length, 2, 'returning restarts the original SDK instance');
  assert.deepEqual(native.lifecycle, ['unlock:utexo', 'shutdown:utexo', 'unlock:regtest', 'shutdown:regtest', 'reinit:utexo']);
  await assert.rejects(oldProvider.burnAsset({}), /network changed/);
  assert.equal(native.requests.length, 0, 'a stale provider stays invalid after switching back');
  assert.equal(wallet.snapshot().lastRequest, null);
});

test('a queued website burn is rejected when the network changes before execution', async () => {
  const { load, native } = nativeWalletFixture();
  const wallet = load();
  await wallet.start();
  let release;
  wallet.queue = new Promise(resolve => { release = resolve; });
  const provider = wallet.provider(context());
  const queued = assert.rejects(provider.burnAsset({}), /network changed/);
  const switching = wallet.selectNetwork('regtest');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(wallet.pair('unused'), /current wallet operation/);
  release();
  await Promise.all([switching, queued]);
  assert.equal(native.requests.length, 0);
  assert.equal(wallet.snapshot().network, 'regtest');
  assert.equal(wallet.snapshot().activeRequest, '');
});

test('switching is blocked while native refresh or user approval is active', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { load, calls } = nativeWalletFixture(undefined, { refresh: () => pending });
  const wallet = load();
  await wallet.start();
  const refreshing = wallet.refresh();
  await wallet.selectNetwork('regtest');
  assert.equal(wallet.snapshot().network, 'utexo');
  assert.ok(!calls.includes('shutdown'));
  release();
  await refreshing;
  const approval = wallet.confirm('Burn?', 'https://test.example', '5 units');
  await wallet.selectNetwork('regtest');
  assert.equal(wallet.snapshot().network, 'utexo');
  wallet.snapshot().prompt.resolve(false);
  assert.equal(await approval, false);
});

test('failed unlock on the new network shows no old balances and can be retried', async () => {
  let broken = true;
  const { load, native } = nativeWalletFixture(undefined, {
    unlock: network => { if (network === 'regtest' && broken) throw new Error('Indexer unavailable'); },
  });
  const wallet = load();
  await wallet.start();
  await wallet.selectNetwork('regtest');
  assert.equal(wallet.snapshot().network, 'regtest');
  assert.equal(wallet.snapshot().ready, false);
  assert.equal(wallet.snapshot().address, '');
  assert.equal(wallet.snapshot().btcBalance, null);
  assert.equal(wallet.snapshot().assets.length, 0);
  assert.equal(wallet.snapshot().error, 'Indexer unavailable');
  broken = false;
  await wallet.start();
  assert.equal(wallet.snapshot().ready, true);
  assert.equal(wallet.snapshot().address, 'saved-regtest-address');
  assert.deepEqual(native.keys, ['utexo-demo-wallet-v1-utexo', 'utexo-demo-wallet-v1-regtest', 'utexo-demo-wallet-v1-regtest']);
});

test('failure to disconnect a persisted session or stop the node prevents a network switch', async () => {
  for (const failure of ['session', 'node']) {
    const { load, client, native } = nativeWalletFixture(undefined, { shutdownError: () => failure === 'node' });
    const wallet = load();
    await wallet.start();
    if (failure === 'session') client.disconnectSession = async () => { throw new Error('Relay unavailable'); };
    await wallet.selectNetwork('regtest');
    assert.equal(wallet.snapshot().ready, true);
    assert.equal(wallet.snapshot().network, 'utexo');
    assert.equal(wallet.snapshot().busy, false);
    assert.equal(native.nodes.length, 1);
    assert.match(wallet.snapshot().error, /Relay unavailable|Could not stop node/);
  }
});

test('a network preference write failure never leaves a stopped wallet marked ready', async () => {
  const { load } = nativeWalletFixture(undefined, { saveError: () => true });
  const wallet = load();
  await wallet.start();
  await wallet.selectNetwork('regtest');
  assert.equal(wallet.snapshot().ready, false);
  assert.equal(wallet.snapshot().btcBalance, null);
  assert.equal(wallet.snapshot().network, 'regtest');
  assert.match(wallet.snapshot().error, /Storage is unavailable/);
});

test('reset during WalletKit initialization does not attach a transport for the old network', async () => {
  let resolve;
  const pending = new Promise(yes => { resolve = yes; });
  const { load, client, stats } = fixture(() => pending);
  const wallet = load();
  const opening = wallet.connection.getClient();
  const resetting = wallet.connection.reset();
  resolve(client);
  await Promise.all([opening, resetting]);
  assert.equal(stats.transports.length, 0);
  await wallet.connection.getClient();
  assert.equal(stats.transports.length, 1);
  assert.equal(stats.clients, 1);
});


test('providers for another network cannot access the selected wallet', async () => {
  const { load, native } = nativeWalletFixture();
  const wallet = load();
  await wallet.start();
  assert.throws(() => wallet.provider({ ...context(), network: 'regtest' }), /does not match/);
  assert.equal(native.requests.length, 0);
});

const localBurnForm = {
  assetId: 'rgb:test', amount: '2', payoutChainId: 'eip155:42161',
  payoutAddress: '0x' + '12'.repeat(20),
};
async function waitForBurnPrompt(wallet) {
  for (let attempt = 0; attempt < 100 && !wallet.snapshot().prompt; attempt++)
    await new Promise(resolve => setImmediate(resolve));
  assert.ok(wallet.snapshot().prompt, wallet.snapshot().error || 'Expected burn confirmation');
  return wallet.snapshot().prompt;
}

test('local burn converts decimal amounts exactly and persists without a website session', async (t) => {
  const { load, native, client, storage } = nativeWalletFixture(undefined, {
    burnAvailable: true, precision: 6, available: () => 2_000_000,
  });
  client.sessions = {};
  const wallet = load();
  await wallet.start();
  t.after(() => wallet.snapshot().prompt?.resolve(false));
  const form = { ...localBurnForm, amount: '1.250001', payoutChainId: 'eip155:1' };
  const task = wallet.burnAsset(form);
  form.payoutAddress = '0x' + '34'.repeat(20);
  const prompt = await waitForBurnPrompt(wallet);
  assert.equal(native.burns.length, 0);
  assert.equal(prompt.origin, 'On this device');
  assert.match(prompt.details, /1\.250001 \(1250001 base units\)/);
  assert.match(prompt.details, /Ethereum/);
  assert.match(prompt.details, /2 sat\/vB/);
  assert.match(prompt.details, /Confirmations: 3/);
  assert.ok(prompt.details.includes(localBurnForm.payoutAddress));
  await wallet.selectNetwork('regtest');
  assert.equal(wallet.snapshot().network, 'utexo');
  await wallet.burnAsset(localBurnForm); // Double tap while review is open.
  prompt.resolve(true);
  const result = await task;
  assert.equal(result.state, 'complete');
  assert.equal(native.burns.length, 1);
  assert.equal(native.burns[0].amount, '1250001');
  assert.equal(native.burns[0].burnRecipient, '0'.repeat(24) + '12'.repeat(20));
  assert.equal(result.metadata.origin, 'local:wallet');
  assert.equal(result.metadata.network, 'utexo');
  assert.equal(result.metadata.payout.chainId, 'eip155:1');
  assert.equal(result.metadata.payout.address, localBurnForm.payoutAddress);
  assert.equal(wallet.snapshot().burns[0].result.txid, 'ab'.repeat(32));
  assert.match(wallet.snapshot().message, /Burn broadcast/);
  assert.equal(wallet.snapshot().busy, false);
  const persisted = JSON.parse(storage.get('utexo-burn-journal-v1:rgb:utexo:saved-node-pubkey'));
  assert.equal(persisted[0].state, 'complete');
});

test('rejecting a local burn neither invokes native burn nor creates a journal entry', async () => {
  const { load, native } = nativeWalletFixture(undefined, { burnAvailable: true });
  const wallet = load();
  await wallet.start();
  const task = wallet.burnAsset(localBurnForm);
  (await waitForBurnPrompt(wallet)).resolve(false);
  assert.equal(await task, undefined);
  assert.equal(native.burns.length, 0);
  assert.equal(wallet.snapshot().burns.length, 0);
  assert.equal(wallet.snapshot().message, 'Burn cancelled.');
});

test('local burn rejects invalid amounts, non-BFA assets, recipients and payout networks before approval', async () => {
  const { load, native } = nativeWalletFixture(undefined, { burnAvailable: true });
  const wallet = load();
  await wallet.start();
  for (const invalid of [
    { amount: '0' }, { amount: '6' }, { amount: '0.1' }, { amount: '1e2' },
    { amount: '-1' }, { amount: '18446744073709551616' },
    { assetId: 'rgb:nia' }, { assetId: 'rgb:absent' },
    { payoutAddress: '0x' + '0'.repeat(40) }, { payoutAddress: 'not-an-address' },
    { payoutChainId: 'eip155:0' },
  ]) {
    await wallet.burnAsset({ ...localBurnForm, ...invalid });
    assert.ok(wallet.snapshot().error, JSON.stringify(invalid));
    assert.equal(wallet.snapshot().prompt, null);
  }
  assert.equal(native.burns.length, 0);
});

test('local burn rechecks available balance after approval', async (t) => {
  let available = 5;
  const { load, native } = nativeWalletFixture(undefined, { burnAvailable: true, available: () => available });
  const wallet = load();
  await wallet.start();
  t.after(() => wallet.snapshot().prompt?.resolve(false));
  const task = wallet.burnAsset(localBurnForm);
  const prompt = await waitForBurnPrompt(wallet);
  available = 1;
  prompt.resolve(true);
  await task;
  assert.equal(native.burns.length, 0);
  assert.equal(wallet.snapshot().burns.length, 0);
  assert.match(wallet.snapshot().error, /available asset balance/);
});

test('local burn cannot execute after its wallet context changes during approval', async (t) => {
  const { load, native } = nativeWalletFixture(undefined, { burnAvailable: true });
  const wallet = load();
  await wallet.start();
  t.after(() => wallet.snapshot().prompt?.resolve(false));
  const task = wallet.burnAsset(localBurnForm);
  const prompt = await waitForBurnPrompt(wallet);
  wallet.generation++;
  prompt.resolve(true);
  await task;
  assert.equal(native.burns.length, 0);
  assert.match(wallet.snapshot().error, /Wallet changed/);
});

test('an ambiguous local native burn blocks another burn, including after reopening the journal', async (t) => {
  const options = { burnAvailable: true, burn: () => { throw new Error('Native connection lost'); } };
  const { load, native, storage } = nativeWalletFixture(undefined, options);
  const wallet = load();
  await wallet.start();
  t.after(() => wallet.snapshot().prompt?.resolve(false));
  const task = wallet.burnAsset(localBurnForm);
  (await waitForBurnPrompt(wallet)).resolve(true);
  await task;
  assert.equal(native.burns.length, 1);
  assert.equal(wallet.snapshot().burns[0].state, 'pending');
  await wallet.burnAsset(localBurnForm);
  assert.match(wallet.snapshot().error, /unresolved outcome/);
  assert.equal(native.burns.length, 1);
  const reopened = nativeWalletFixture(undefined, { burnAvailable: true });
  for (const [key, value] of storage) reopened.storage.set(key, value);
  const restored = reopened.load();
  await restored.start();
  await restored.burnAsset(localBurnForm);
  assert.match(restored.snapshot().error, /unresolved outcome/);
  assert.equal(reopened.native.burns.length, 0);
  assert.equal(restored.snapshot().prompt, null);
});

test('refresh saves a known local burn result after storage failure without burning again', async (t) => {
  let broken = false;
  const { load, native } = nativeWalletFixture(undefined, {
    burnAvailable: true, saveError: () => broken, burn: () => { broken = true; },
  });
  const wallet = load();
  await wallet.start();
  t.after(() => wallet.snapshot().prompt?.resolve(false));
  const task = wallet.burnAsset(localBurnForm);
  (await waitForBurnPrompt(wallet)).resolve(true);
  await task;
  assert.equal(wallet.snapshot().burns[0].state, 'pending');
  assert.match(wallet.snapshot().error, /Storage is unavailable/);
  broken = false;
  await wallet.refresh();
  assert.equal(native.burns.length, 1);
  assert.equal(wallet.snapshot().burns[0].state, 'complete');
  assert.equal(wallet.snapshot().burns[0].result.txid, 'ab'.repeat(32));
});

test('local burn retains its result when the subsequent balance refresh fails', async (t) => {
  let burned = false;
  const { load, native } = nativeWalletFixture(undefined, {
    burnAvailable: true, burn: () => { burned = true; }, readError: () => burned,
  });
  const wallet = load();
  await wallet.start();
  t.after(() => wallet.snapshot().prompt?.resolve(false));
  const task = wallet.burnAsset(localBurnForm);
  (await waitForBurnPrompt(wallet)).resolve(true);
  const result = await task;
  assert.equal(result.state, 'complete');
  assert.equal(wallet.snapshot().burns[0].state, 'complete');
  assert.match(wallet.snapshot().error, /Burn broadcast; balances could not refresh/);
  assert.equal(native.burns.length, 1);
});

test('burn amount and Max helpers preserve decimals and reject unsafe numeric balances', () => {
  const { loadBurn } = nativeWalletFixture();
  const { burnBaseUnits, formatBurnAmount, burnMaxAmount, assertBurnBalance } = loadBurn();
  assert.equal(burnBaseUnits('0.000001', 6), '1');
  assert.equal(burnBaseUnits(' 01.2300 ', 6), '1230000');
  assert.equal(burnBaseUnits('18446744073709551615', 0), '18446744073709551615');
  assert.equal(formatBurnAmount('1000001', 6), '1.000001');
  assert.equal(burnMaxAmount({ precision: 6, balance: { spendable: 1_250_001 } }), '1.250001');
  assert.equal(burnMaxAmount({ precision: 6, balance: { spendable: Number.MAX_SAFE_INTEGER + 1 } }), null);
  for (const value of ['0.0000001', '1,5', 'Infinity', '1e6', '0', '-0.1'])
    assert.throws(() => burnBaseUnits(value, 6));
  assert.throws(() => assertBurnBalance('1', Number.MAX_SAFE_INTEGER + 1), /unsupported available balance/);
  assert.throws(() => assertBurnBalance('1', undefined), /unsupported available balance/);
});
