import { BurnOperations, normalizeBurnRecord } from '@utexo/rgb-sdk-rn';
import { burnDestinationHash, createBurnDestination, encodeEvmBurnRecipient, encodeTronBurnRecipient } from '@utexo/rgb-sdk-rn/webrgb';
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

function fixture(init, modules = {}, env = {}) {
  const stats = { cores: 0, clients: 0, listeners: 0, seenCores: [], transports: [], disposedTransports: 0, coreOptions: [] };
  const client = {
    on: () => { stats.listeners++; },
    sessions: {},
    getActiveSessions: () => client.sessions,
    disconnectSession: async ({ topic }) => { delete client.sessions[topic]; },
    core: { expirer: { on: () => { stats.listeners++; } } },
  };
  const context = vm.createContext({
    process: { env: { EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID: 'a'.repeat(32), ...env } },
    setTimeout, clearTimeout, Error,
    require: (name) => {
      if (name === '@utexo/rgb-sdk-rn') return { BurnOperations, normalizeBurnRecord, ...modules[name] };
      if (Object.hasOwn(modules, name)) return modules[name];
      if (name === '@utexo/rgb-sdk-rn/webrgb') return { WEBRGB_READ_METHODS: ['enable', 'getInfo'], burnDestinationHash, createBurnDestination, encodeEvmBurnRecipient, encodeTronBurnRecipient };
      if (name === '@walletconnect/core') return { Core: class { constructor(options) { stats.cores++; stats.coreOptions.push(options); } } };
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
  const load = (protocol = 'RGB_LN') => loadFile(fileURLToPath(new URL('../utils/wallet/service.ts', import.meta.url)), true)[protocol === 'RGB_L1' ? 'rgbLibWallet' : 'demoWallet'];
  const loadBurn = () => loadFile(fileURLToPath(new URL('../utils/wallet/burn.ts', import.meta.url)));
  const loadRgbConfig = () => loadFile(fileURLToPath(new URL('../utils/wallet/rgb-lib-node.ts', import.meta.url))).buildRgbLibConfig;
  return { stats, load, client, loadBurn, loadRgbConfig };
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
  const native = { refreshes: 0, invoices: [], failedTransfers: [], createdUtxos: [], requests: [], responses: [], nodes: [], keys: [], storageReads: [], lifecycle: [], burns: [], mnemonics: [], deletedDirectories: [], deletedKeys: [] };
  const storage = new Map(options.savedNetwork ? [['utexo-demo-wallet-network-v1', options.savedNetwork]] : []);
  const savedKeys = options.savedKeys ?? new Map(options.newRgbKeys ? [] : ['utexo', 'regtest'].map(network =>
    [`utexo-demo-wallet-v1-RGB_L1-${network}-default-taproot`, 'saved-rgb-mnemonic']));
  let generatedKeys = 0;
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
        if (key.includes('RGB_L1')) return savedKeys.get(key) ?? null;
        return JSON.stringify({ mnemonic: 'saved-test-mnemonic', password: 'saved-test-password' });
      },
      setItemAsync: async (key, value) => {
        await options.writeKey?.(key);
        calls.push(key.endsWith('-deleting') ? 'markDeleting' : 'replaceCredentials');
        savedKeys.set(key, value);
      },
      deleteItemAsync: async (key) => {
        await options.deleteKey?.(key);
        calls.push(key.endsWith('-deleting') ? 'clearDeleting' : 'deleteCredentials');
        native.deletedKeys.push(key);
        savedKeys.delete(key);
      },
    },
    'expo-file-system/legacy': {
      documentDirectory: 'file:///mock-wallet/',
      makeDirectoryAsync: async () => {},
      deleteAsync: async (directory, config) => {
        assert.equal(config.idempotent, true);
        await options.deleteFiles?.();
        calls.push('deleteFiles');
        native.deletedDirectories.push(directory);
      },
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
      createWallet: async () => {
        if (options.newRgbKeys || options.regenerateRgbKeys) return { mnemonic: ++generatedKeys === 1 ? 'new-rgb-mnemonic' : `new-rgb-mnemonic-${generatedKeys}` };
        throw new Error('Must reuse saved keys');
      },
      CallbackRgbLibKeyProvider: class { constructor(read) { this.getMnemonic = read; } },
      PasswordRLNSigner: class {
        constructor(password, mnemonic) {
          assert.equal(password, 'saved-test-password');
          assert.equal(mnemonic, 'saved-test-mnemonic');
        }
      },
      UTEXOWallet: class {
        constructor(input) {
          this.protocol = input.protocol ?? 'RGB_LN';
          const params = input.params ?? input;
          this.network = params.network; this.keys = input.keys;
          native.nodes.push(params);
        }
        async init() {
          calls.push('init');
          if (this.protocol === 'RGB_L1') {
            const mnemonic = await this.keys.getMnemonic();
            assert.equal(mnemonic, savedKeys.get(`utexo-demo-wallet-v1-RGB_L1-${this.network}-default-taproot`));
            native.mnemonics.push(mnemonic);
            await options.rgbInit?.();
          }
          if (initError) throw new Error(initError);
        }
        async unlock(params) {
          if (this.protocol === 'RGB_LN') assert.equal(params, configs[this.network].unlockParams);
          else assert.equal(params.indexerUrl, `tcp://${this.network}.test:50001`);
          calls.push('unlock'); native.lifecycle.push(`unlock:${this.network}`);
          await options.unlock?.(this.network);
        }
        async shutdown() {
          if (options.shutdownError?.()) throw new Error('Could not stop node');
          calls.push('shutdown'); native.lifecycle.push(`shutdown:${this.network}`);
        }
        async reinit(params) {
          if (this.protocol === 'RGB_LN') assert.equal(params, configs[this.network].unlockParams);
          else assert.equal(params.indexerUrl, `tcp://${this.network}.test:50001`);
          calls.push('reinit'); native.lifecycle.push(`reinit:${this.network}`);
          await options.unlock?.(this.network);
        }
        async getAddress() { return this.network === 'utexo' ? 'saved-btc-address' : 'saved-regtest-address'; }
        async getNodeInfo() { assert.equal(this.protocol, 'RGB_LN'); return { pubkey: 'saved-node-pubkey' }; }
        async getWalletIdentity() { return { id: 'saved-node-pubkey', network: this.network, protocol: this.protocol }; }
        async getBfaCapabilities() { await options.capabilities?.(); return { burn: !!options.burnAvailable, consignment: !!options.burnAvailable }; }
        async getAssetBalance() { return { spendable: options.available?.() ?? 5 }; }
        async burn(params) {
          const journal = JSON.parse(storage.get(`utexo-burn-journal-v1:rgb:${this.network}:${this.protocol === 'RGB_L1' ? 'RGB-L1-' : ''}saved-node-pubkey`));
          assert.equal(journal.at(-1).state, 'pending', 'Persist before invoking native burn');
          native.burns.push(params);
          await options.burn?.(params);
          return { txid: 'ab'.repeat(32), batchTransferIdx: 3 };
        }
        async getBtcBalance() { return btc; }
        async createUtxos(params) { native.createdUtxos.push({ ...params }); return (await options.createUtxos?.(params)) ?? 4; }
        async listAssets() {
          if (options.readError?.(this.network)) throw new Error('Indexer unavailable');
          return { bfa: [{ assetId: 'rgb:test', ticker: 'TEST', name: 'Test asset', precision: options.precision ?? 0,
            balance: { spendable: options.available?.() ?? 5, settled: 5, future: 5 } }],
            nia: [{ assetId: 'rgb:nia', name: 'NIA test', precision: 0, balance: { spendable: 2, settled: 2, future: 2 } }], uda: null };
        }
        async listTransfers(assetId) {
          if (options.transfers) return options.transfers(assetId);
          if (this.protocol === 'RGB_L1' && assetId === undefined) return [{ idx: 1, createdAt: 100 }, { idx: 2, createdAt: 200 }, { idx: 3, createdAt: 300, kind: 'ReceiveBlind', status: 'WaitingCounterparty' }];
          assert.ok(['rgb:test', 'rgb:nia'].includes(assetId), 'RLN requires a transfer filter');
          if (assetId === 'rgb:nia') return [];
          return [{ idx: 1, createdAt: 100 }, { idx: 2, createdAt: 200 }];
        }
        async refreshTransfers() { native.refreshes++; return (await options.refresh?.()) ?? { transfers: {} }; }
        async failTransfers(params) { native.failedTransfers.push({ ...params }); return options.failTransfers?.(params) ?? false; }
        async refreshWallet() { await this.refreshTransfers(); }
        async blindReceive(params) {
          native.invoices.push(params);
          return { invoice: 'rgb:test-invoice', expirationTimestamp: 1234567890 };
        }
        async dispose() { calls.push('dispose'); await options.dispose?.(); }
      },
    },
  };
  const result = fixture(undefined, modules, {
    EXPO_PUBLIC_RGB_LIB_UTEXO_INDEXER_URL: 'tcp://utexo.test:50001',
    EXPO_PUBLIC_RGB_LIB_UTEXO_PROXY_ENDPOINT: 'rpc://utexo.test:3000/json-rpc',
    EXPO_PUBLIC_RGB_LIB_REGTEST_INDEXER_URL: 'tcp://regtest.test:50001',
    EXPO_PUBLIC_RGB_LIB_REGTEST_PROXY_ENDPOINT: 'rpc://regtest.test:3000/json-rpc',
    ...options.env,
  });
  const session = {
    topic: 'test-topic', expiry: Math.floor(Date.now() / 1000) + 3600,
    peer: { metadata: { url: 'https://test.example' } },
    namespaces: { rgb: { methods: ['rgb_getAssetBalance', 'rgb_burnAsset'] } },
  };
  result.client.sessions = { [session.topic]: session };
  return { ...result, calls, native, btc, storage, savedKeys };
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
  await wallet.generateInvoice({ amount: '5', durationMinutes: '180' });
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

test('refresh surfaces per-batch failures while still publishing fresh balances and can retry', async () => {
  for (const protocol of ['RGB_LN', 'RGB_L1']) {
    let broken = true, available = 5;
    const { load, native } = nativeWalletFixture(undefined, {
      available: () => available,
      refresh: () => ({ transfers: broken ? {
        42: { failure: { name: 'RGB_LIB_Network', message: 'Mint validation RPC unavailable' } },
        43: { updatedStatus: 'Settled' },
      } : {} }),
    });
    const wallet = load(protocol);
    await wallet.start();
    available = 7;
    await wallet.refresh();
    assert.match(wallet.snapshot().error, /Batch 42: RGB_LIB_Network: Mint validation RPC unavailable/);
    assert.match(wallet.snapshot().message, /some transfers could not refresh/);
    assert.equal(wallet.snapshot().assets[0].balance.spendable, 7, 'Other transfers still update');
    assert.equal(wallet.snapshot().refreshing, false);
    assert.equal(wallet.snapshot().busy, false);
    broken = false;
    await wallet.refresh();
    assert.equal(wallet.snapshot().error, '');
    assert.equal(native.refreshes, 2, 'One native refresh per action');
  }
});

test('RGB Lib refresh explains that unknown-asset receives are still pending', async () => {
  const { load } = nativeWalletFixture();
  const wallet = load('RGB_L1');
  await wallet.start();
  await wallet.refresh();
  assert.equal(wallet.snapshot().error, '');
  assert.match(wallet.snapshot().message, /1 transfer still pending; check Activity/);
  assert.equal(wallet.snapshot().transfers[0].status, 'WaitingCounterparty');
});

test('local invoices validate amount, asset and expiry before allocating a receive UTXO', async () => {
  const { load, native } = nativeWalletFixture();
  const wallet = load();
  await wallet.start();
  for (const amount of ['-1', '0', '1.5', '1e3', '9007199254740992']) {
    await wallet.generateInvoice({ amount, durationMinutes: '180' });
    assert.match(wallet.snapshot().error, /positive whole amount/);
  }
  await wallet.generateInvoice({ amount: '5', assetId: 'rgb:unknown', durationMinutes: '180' });
  assert.match(wallet.snapshot().error, /Select an asset/);
  for (const durationMinutes of ['0', '60', '179', '180.5', '43201']) {
    await wallet.generateInvoice({ amount: '5', durationMinutes });
    assert.match(wallet.snapshot().error, /expiry must be between 180 and 43,200 minutes/);
  }
  assert.equal(native.invoices.length, 0);
  await wallet.generateInvoice({ amount: '5', assetId: 'rgb:nia', durationMinutes: '180' });
  assert.deepEqual(JSON.parse(JSON.stringify(native.invoices[0])), {
    amount: 5, assetId: 'rgb:nia', durationSeconds: 10800, minConfirmations: 3,
  });
  assert.equal(wallet.snapshot().invoice.amount, 5);
  assert.equal(wallet.snapshot().invoice.source, 'Created on this device');
  await wallet.generateInvoice({ amount: '', durationMinutes: '360' });
  assert.equal(native.invoices[1].amount, undefined);
  assert.equal(native.invoices[1].assetId, undefined);
  assert.equal(native.invoices[1].durationSeconds, 21600);
});

test('BFA receive preserves the asset constraint and never silently removes a requested amount', async () => {
  const { load, native } = nativeWalletFixture();
  const wallet = load();
  await wallet.start();
  await wallet.generateInvoice({ amount: '5', assetId: 'rgb:test', durationMinutes: '180' });
  assert.match(wallet.snapshot().error, /BFA build requires an open amount/);
  assert.equal(native.invoices.length, 0);
  await wallet.generateInvoice({ amount: '', assetId: 'rgb:test', durationMinutes: '180' });
  assert.equal(native.invoices[0].assetId, 'rgb:test');
  assert.equal(native.invoices[0].amount, undefined);
});

test('a generated invoice is retained if the follow-up balance read fails', async () => {
  let broken = false;
  const { load, native } = nativeWalletFixture(undefined, { readError: () => broken });
  const wallet = load();
  await wallet.start();
  broken = true;
  await wallet.generateInvoice({ amount: '5', durationMinutes: '180' });
  assert.equal(native.invoices.length, 1);
  assert.equal(wallet.snapshot().invoice.invoice, 'rgb:test-invoice');
  assert.match(wallet.snapshot().error, /Invoice created; balances could not refresh/);
});

test('UTXO preparation explains existing allocations without silently creating an extra transaction', async () => {
  const { load, native } = nativeWalletFixture(undefined, {
    createUtxos: () => { throw new Error('AllocationsAlreadyAvailable'); },
  });
  const wallet = load('RGB_L1');
  await wallet.start();
  await wallet.prepareReceive();
  assert.deepEqual(native.createdUtxos, [{ upTo: true, num: 4, size: 1000, feeRate: 2 }]);
  assert.equal(wallet.snapshot().error, '');
  assert.match(wallet.snapshot().message, /Create 4 additional UTXOs/);
  assert.equal(wallet.snapshot().prompt, null);
});

test('additional UTXOs require approval and bypass the existing allocation count exactly once', async (t) => {
  const { load, native } = nativeWalletFixture(undefined, { createUtxos: () => 3 });
  const wallet = load('RGB_L1');
  await wallet.start();
  t.after(() => wallet.snapshot().prompt?.resolve(false));
  const task = wallet.prepareReceive('additional');
  const prompt = await waitForWalletPrompt(wallet);
  assert.match(prompt.details, /Network: utexo/);
  assert.match(prompt.details, /1,000 sats/);
  assert.match(prompt.details, /2 sat\/vB/);
  assert.equal(native.createdUtxos.length, 0);
  await wallet.prepareReceive('additional');
  await wallet.selectNetwork('regtest');
  prompt.resolve(true);
  await task;
  assert.deepEqual(native.createdUtxos, [{ upTo: false, num: 4, size: 1000, feeRate: 2 }]);
  assert.equal(wallet.snapshot().network, 'utexo');
  assert.match(wallet.snapshot().message, /3 RGB UTXOs created/);
});

test('rejected or stale UTXO approval never spends BTC', async (t) => {
  for (const stale of [false, true]) {
    const { load, native } = nativeWalletFixture();
    const wallet = load();
    await wallet.start();
    t.after(() => wallet.snapshot().prompt?.resolve(false));
    const task = wallet.prepareReceive('additional');
    const prompt = await waitForWalletPrompt(wallet);
    if (stale) wallet.generation++;
    prompt.resolve(stale);
    await task;
    assert.equal(native.createdUtxos.length, 0);
    if (stale) assert.match(wallet.snapshot().error, /Wallet changed/);
    else assert.equal(wallet.snapshot().message, 'UTXO creation cancelled.');
  }
});

test('UTXO creation preserves broadcast success if balances fail and never hides unrelated failures', async () => {
  let created = false;
  const { load, native } = nativeWalletFixture(undefined, {
    createUtxos: () => { created = true; return 2; }, readError: () => created,
  });
  const wallet = load();
  await wallet.start();
  await wallet.prepareReceive();
  assert.equal(native.createdUtxos.length, 1);
  assert.match(wallet.snapshot().message, /2 RGB UTXOs created/);
  assert.match(wallet.snapshot().error, /UTXOs created; balances could not refresh/);
  const broken = nativeWalletFixture(undefined, { createUtxos: () => { throw new Error('InsufficientBitcoins'); } });
  const other = broken.load();
  await other.start();
  await other.prepareReceive();
  assert.equal(other.snapshot().error, 'InsufficientBitcoins');
  assert.equal(broken.native.createdUtxos.length, 1);
});

const pendingInvoice = {
  idx: 11, batchTransferIdx: 42, createdAt: 100, kind: 'ReceiveBlind', status: 'WaitingCounterparty',
  invoiceString: 'rgb:test-invoice', recipientId: 'blinded-receive',
};

test('cancelling an invoice fails only its batch after approval and refreshes the released balance', async (t) => {
  for (const knownAsset of [false, true]) {
    let records = [{ ...pendingInvoice }, { ...pendingInvoice, idx: 12, batchTransferIdx: 43 }];
    const { load, native } = nativeWalletFixture(undefined, {
      transfers: assetId => assetId === undefined || (knownAsset && assetId === 'rgb:test') ? records : [],
      available: () => records[0].status === 'Failed' ? 5 : 0,
      failTransfers: ({ batchTransferIdx }) => {
        records = records.map(record => record.batchTransferIdx === batchTransferIdx ? { ...record, status: 'Failed' } : record);
        return true;
      },
    });
    const wallet = load('RGB_L1');
    await wallet.start();
    await wallet.generateInvoice({ amount: '', durationMinutes: '180' });
    t.after(() => wallet.snapshot().prompt?.resolve(false));
    assert.equal(wallet.snapshot().assets[0].balance.spendable, 0);
    const task = wallet.cancelInvoice(11);
    const prompt = await waitForWalletPrompt(wallet);
    assert.equal(prompt.title, 'Cancel receive invoice?');
    assert.match(prompt.details, /Invoice #11/);
    assert.equal(native.failedTransfers.length, 0);
    await wallet.selectNetwork('regtest');
    await wallet.cancelInvoice(12); // Double tap must not cancel another invoice.
    assert.equal(wallet.snapshot().network, 'utexo');
    prompt.resolve(true);
    await task;
    assert.equal(JSON.stringify(native.failedTransfers), JSON.stringify([{ batchTransferIdx: 42, noAssetOnly: !knownAsset, skipSync: false }]));
    assert.equal(wallet.snapshot().transfers.find(transfer => transfer.idx === 11).status, 'Failed');
    assert.equal(wallet.snapshot().transfers.find(transfer => transfer.idx === 12).status, 'WaitingCounterparty');
    assert.equal(wallet.snapshot().invoice, null);
    assert.equal(wallet.snapshot().assets[0].balance.spendable, 5);
    assert.match(wallet.snapshot().message, /Invoice #11 cancelled/);
    assert.equal(wallet.snapshot().error, '');
    assert.equal(wallet.snapshot().busy, false);
  }
});

test('invoice cancellation rejects sends, burns, advanced receives and missing or shared batch identifiers', async () => {
  for (const invalid of [
    { kind: 'Send' }, { kind: 'Burn' }, { status: 'Settled' }, { status: 'Failed' },
    { status: 'WaitingConfirmations' }, { status: 'WaitingBroadcast' }, { txid: 'abc' },
    { batchTransferIdx: undefined }, { batchTransferIdx: 0 }, { batchTransferIdx: -1 },
    { batchTransferIdx: 1.5 }, { batchTransferIdx: 0x80000000 },
    { sharedBatch: true },
  ]) {
    const records = [{ ...pendingInvoice, ...invalid }];
    if (invalid.sharedBatch) records.push({ ...pendingInvoice, idx: 12 });
    const { load, native } = nativeWalletFixture(undefined, { transfers: assetId => assetId ? [] : records });
    const wallet = load('RGB_L1');
    await wallet.start();
    await wallet.cancelInvoice(11);
    assert.ok(wallet.snapshot().error, JSON.stringify(invalid));
    assert.equal(wallet.snapshot().prompt, null);
    assert.equal(native.failedTransfers.length, 0);
  }
});

test('invoice cancellation respects rejection and rechecks transfer and wallet state after approval', async (t) => {
  for (const change of ['reject', 'progress', 'batch', 'wallet']) {
    let record = { ...pendingInvoice };
    const { load, native } = nativeWalletFixture(undefined, { transfers: assetId => assetId ? [] : [record] });
    const wallet = load('RGB_L1');
    await wallet.start();
    t.after(() => wallet.snapshot().prompt?.resolve(false));
    const task = wallet.cancelInvoice(11);
    const prompt = await waitForWalletPrompt(wallet);
    if (change === 'progress') record = { ...record, status: 'WaitingConfirmations', txid: 'abc' };
    if (change === 'batch') record = { ...record, batchTransferIdx: 99 };
    if (change === 'wallet') wallet.generation++;
    prompt.resolve(change !== 'reject');
    await task;
    assert.equal(native.failedTransfers.length, 0);
    if (change === 'reject') assert.equal(wallet.snapshot().message, 'Invoice kept active.');
    else assert.ok(wallet.snapshot().error);
    if (change === 'progress') assert.equal(wallet.snapshot().transfers[0].status, 'WaitingConfirmations');
  }
});

test('native refresh or refusal is never reported as a cancelled invoice', async (t) => {
  for (const outcome of ['unchanged', 'advanced', 'refused']) {
    let record = { ...pendingInvoice };
    const { load, native } = nativeWalletFixture(undefined, {
      transfers: assetId => assetId ? [] : [record],
      failTransfers: () => {
        if (outcome === 'unchanged') return false;
        record = { ...record, status: 'WaitingBroadcast' };
        if (outcome === 'refused') throw new Error('Cannot fail transfer');
        return true; // Native refreshed the receive instead of failing it.
      },
    });
    const wallet = load('RGB_L1');
    await wallet.start();
    await wallet.generateInvoice({ amount: '', durationMinutes: '180' });
    t.after(() => wallet.snapshot().prompt?.resolve(false));
    const task = wallet.cancelInvoice(11);
    (await waitForWalletPrompt(wallet)).resolve(true);
    await task;
    assert.equal(native.failedTransfers.length, 1);
    assert.match(wallet.snapshot().message, /was not cancelled/);
    assert.equal(wallet.snapshot().transfers[0].status, record.status);
    assert.ok(wallet.snapshot().invoice);
    if (outcome === 'refused') assert.match(wallet.snapshot().error, /Cannot fail transfer/);
  }
});

test('confirmed invoice cancellation stays visible and cannot be copied when balances fail to refresh', async (t) => {
  let record = { ...pendingInvoice };
  const { load, native } = nativeWalletFixture(undefined, {
    transfers: assetId => assetId ? [] : [record],
    readError: () => record.status === 'Failed',
    failTransfers: () => { record = { ...record, status: 'Failed' }; return true; },
  });
  const wallet = load('RGB_L1');
  await wallet.start();
  await wallet.generateInvoice({ amount: '', durationMinutes: '180' });
  t.after(() => wallet.snapshot().prompt?.resolve(false));
  const task = wallet.cancelInvoice(11);
  (await waitForWalletPrompt(wallet)).resolve(true);
  await task;
  assert.equal(wallet.snapshot().invoice, null);
  assert.equal(wallet.snapshot().transfers[0].status, 'Failed');
  assert.match(wallet.snapshot().message, /Invoice #11 cancelled/);
  assert.match(wallet.snapshot().error, /Invoice cancelled; balances could not refresh/);
  await wallet.cancelInvoice(11);
  assert.equal(native.failedTransfers.length, 1);
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
  assert.equal(signet.unlockParams.indexerUrl, 'https://dev.esplora-01.mint.utexo.com');
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
  const mainnet = exports.buildDemoWalletConfig('mainnet');
  assert.equal(mainnet.network, 'mainnet');
  assert.equal(mainnet.unlockParams.indexerUrl, 'ssl://electrs-01.utexo.com:50002');
  assert.equal(mainnet.unlockParams.proxyEndpoint, 'rpcs://rgb-proxy.utexo.com/json-rpc');
  const publicSignet = exports.buildDemoWalletConfig('signet');
  assert.equal(publicSignet.network, 'signet');
  assert.equal(publicSignet.unlockParams.indexerUrl, 'ssl://electrum.iriswallet.com:50033');
  assert.throws(() => exports.buildDemoWalletConfig('testnet'), /Unsupported/);
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
  await wallet.generateInvoice({ amount: '5', durationMinutes: '180' });
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
async function waitForWalletPrompt(wallet) {
  for (let attempt = 0; attempt < 100 && !wallet.snapshot().prompt; attempt++)
    await new Promise(resolve => setImmediate(resolve));
  assert.ok(wallet.snapshot().prompt, wallet.snapshot().error || 'Expected wallet confirmation');
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
  const prompt = await waitForWalletPrompt(wallet);
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

test('local burn to Tron keeps the Base58Check address and encodes the account bytes', async (t) => {
  const { load, native } = nativeWalletFixture(undefined, { burnAvailable: true });
  const wallet = load();
  await wallet.start();
  t.after(() => wallet.snapshot().prompt?.resolve(false));
  const tronAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const task = wallet.burnAsset({ ...localBurnForm, payoutChainId: 'tron:728126428', payoutAddress: tronAddress });
  const prompt = await waitForWalletPrompt(wallet);
  assert.match(prompt.details, /Payout network: Tron \(tron:728126428\)/);
  assert.ok(prompt.details.includes(tronAddress));
  prompt.resolve(true);
  const result = await task;
  assert.equal(result.state, 'complete');
  assert.equal(native.burns[0].burnRecipient, encodeTronBurnRecipient(tronAddress));
  assert.deepEqual(result.metadata.payout, { chainId: 'tron:728126428', address: tronAddress });
});

test('rejecting a local burn neither invokes native burn nor creates a journal entry', async () => {
  const { load, native } = nativeWalletFixture(undefined, { burnAvailable: true });
  const wallet = load();
  await wallet.start();
  const task = wallet.burnAsset(localBurnForm);
  (await waitForWalletPrompt(wallet)).resolve(false);
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
    { payoutChainId: 'eip155:0' }, { payoutChainId: 'tron:1' }, { payoutChainId: 'solana:1' },
    { payoutChainId: 'tron:728126428' }, // EVM address on a Tron chain.
    { payoutChainId: 'tron:728126428', payoutAddress: 'tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t' },
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
  const prompt = await waitForWalletPrompt(wallet);
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
  const prompt = await waitForWalletPrompt(wallet);
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
  (await waitForWalletPrompt(wallet)).resolve(true);
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
  (await waitForWalletPrompt(wallet)).resolve(true);
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
  (await waitForWalletPrompt(wallet)).resolve(true);
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

test('RLN and RGB Lib coexist with separate keys, directories, preferences, journals and sessions', async () => {
  const { load, native, stats, storage } = nativeWalletFixture(undefined, { burnAvailable: true });
  const rln = load();
  const rgb = load('RGB_L1');
  assert.notEqual(rln, rgb);
  await rln.start();
  await rgb.start();
  assert.equal(rln.snapshot().ready, true, rln.snapshot().error);
  assert.equal(rgb.snapshot().ready, true, rgb.snapshot().error);
  assert.equal(rln.snapshot().protocol, 'RGB_LN');
  assert.equal(rgb.snapshot().protocol, 'RGB_L1');
  assert.equal(rln.snapshot().burnAvailable, true);
  assert.equal(rgb.snapshot().burnAvailable, true);
  assert.equal(native.nodes[0].storageDirPath, '/mock-wallet/wallet-connect-v1/utexo');
  assert.equal(native.nodes[1].storageDirPath, '/mock-wallet/wallet-connect-v1/RGB_L1/utexo/default/taproot');
  assert.ok(native.keys.includes('utexo-demo-wallet-v1-utexo'));
  assert.ok(native.keys.includes('utexo-demo-wallet-v1-RGB_L1-utexo-default-taproot'));
  assert.ok(native.storageReads.includes('utexo-burn-journal-v1:rgb:utexo:saved-node-pubkey'));
  assert.ok(native.storageReads.includes('utexo-burn-journal-v1:rgb:utexo:RGB-L1-saved-node-pubkey'));
  assert.deepEqual(stats.coreOptions.map((config) => config.customStoragePrefix), [
    'utexo-demo-wallet-webrgb-v2', 'utexo-demo-wallet-webrgb-v2-RGB_L1',
  ]);
  assert.equal(stats.transports[0].account, 'saved-node-pubkey');
  assert.equal(stats.transports[1].account, 'RGB-L1-saved-node-pubkey');
  assert.ok(stats.transports[1].methods.includes('burnAsset'));
  assert.ok(stats.transports[1].methods.includes('getConsignment'));
  const original = rln.snapshot();
  await rgb.selectNetwork('regtest');
  assert.equal(rgb.snapshot().network, 'regtest');
  assert.equal(rgb.snapshot().ready, true, rgb.snapshot().error);
  assert.equal(rln.snapshot(), original, 'Switching RGB Lib must not modify RLN');
  assert.equal(storage.get('utexo-demo-wallet-network-v1-RGB_L1'), 'regtest');
  assert.equal(storage.has('utexo-demo-wallet-network-v1'), false);
  await rgb.selectNetwork('utexo');
  assert.equal(rgb.snapshot().ready, true, rgb.snapshot().error);
  assert.equal(native.nodes.length, 3, 'Returning reuses the stopped RGB Lib facade');
});

test('RGB Lib keeps unknown-asset pending receives and uses its own invoice actions', async () => {
  const { load, native } = nativeWalletFixture();
  const rln = load();
  const rgb = load('RGB_L1');
  await rgb.start();
  assert.equal(rgb.snapshot().ready, true, rgb.snapshot().error);
  assert.equal(rgb.snapshot().transfers.length, 3);
  assert.equal(rgb.snapshot().transfers[0].assetId, '');
  assert.equal(rgb.snapshot().transfers[1].assetId, 'rgb:test');
  await rgb.generateInvoice({ amount: '5', durationMinutes: '180' });
  assert.equal(native.invoices.length, 1);
  assert.equal(rgb.snapshot().invoice.amount, 5);
  assert.equal(rln.snapshot().invoice, null);
  await rgb.burnAsset({ assetId: 'rgb:test', amount: '1', payoutChainId: '1', payoutAddress: '0x' + '12'.repeat(20) });
  assert.match(rgb.snapshot().error, /Burn is unavailable/);
  assert.equal(native.burns.length, 0);
  assert.equal(rgb.snapshot().prompt, null);
});

test('RGB Lib saves keys before init and retries a missing native backend without affecting Wallet', async () => {
  let missing = true;
  const { load, native, calls } = nativeWalletFixture(undefined, {
    newRgbKeys: true,
    rgbInit: () => { if (missing) throw new Error('NATIVE_BACKEND_UNAVAILABLE'); },
  });
  const rgb = load('RGB_L1');
  await rgb.start();
  assert.equal(rgb.snapshot().ready, false);
  assert.equal(rgb.snapshot().error, 'NATIVE_BACKEND_UNAVAILABLE');
  assert.ok(calls.indexOf('replaceCredentials') < calls.indexOf('init'));
  const rln = load();
  await rln.start();
  assert.equal(rln.snapshot().ready, true, rln.snapshot().error);
  missing = false;
  await rgb.start();
  assert.equal(rgb.snapshot().ready, true, rgb.snapshot().error);
  assert.equal(calls.filter((call) => call === 'replaceCredentials').length, 1);
  assert.equal(native.nodes[0].storageDirPath, native.nodes[2].storageDirPath);
});

test('RGB Lib retains a failed cleanup handle and closes it before opening another native wallet', async () => {
  let failOpen = true, failClose = true;
  const { load, native } = nativeWalletFixture(undefined, {
    rgbInit: () => { if (failOpen) throw new Error('Could not initialize'); },
    dispose: () => { if (failClose) throw new Error('Could not close'); },
  });
  const rgb = load('RGB_L1');
  await rgb.start();
  assert.equal(rgb.snapshot().ready, false);
  assert.match(rgb.snapshot().error, /Retry Open wallet/);
  await rgb.start();
  assert.equal(native.nodes.length, 1, 'No new owner while cleanup fails');
  failClose = false;
  failOpen = false;
  await rgb.start();
  assert.equal(rgb.snapshot().ready, true, rgb.snapshot().error);
  assert.equal(native.nodes.length, 2);
});


test('RGB Lib requires explicit per-network endpoints and chain IDs instead of inheriting RLN settings', () => {
  const env = {
    EXPO_PUBLIC_UTEXO_INDEXER_URL: 'https://old-rln.example',
    EXPO_PUBLIC_UTEXO_PROXY_ENDPOINT: 'rpcs://old-rln.example/rpc',
    EXPO_PUBLIC_UTEXO_ETH_RPC_URL: 'https://old-evm.example',
  };
  assert.throws(() => fixture(undefined, {}, env).loadRgbConfig()('utexo'), /EXPO_PUBLIC_RGB_LIB_UTEXO_INDEXER_URL/);
  const configured = { ...env,
    EXPO_PUBLIC_RGB_LIB_UTEXO_INDEXER_URL: 'https://new.example',
    EXPO_PUBLIC_RGB_LIB_UTEXO_PROXY_ENDPOINT: 'rpcs://proxy.example/rpc',
  };
  const config = fixture(undefined, {}, configured).loadRgbConfig();
  assert.equal(config('utexo').unlockParams.evmRpcUrls, undefined);
  assert.throws(() => config('regtest'), /EXPO_PUBLIC_RGB_LIB_REGTEST_INDEXER_URL/);
  configured.EXPO_PUBLIC_RGB_LIB_UTEXO_EVM_RPC_URLS = '{"1":"https://evm.example"}';
  assert.equal(fixture(undefined, {}, configured).loadRgbConfig()('utexo').unlockParams.evmRpcUrls['1'], 'https://evm.example');
  configured.EXPO_PUBLIC_RGB_LIB_UTEXO_EVM_RPC_URLS = '{"guess":"https://evm.example"}';
  assert.throws(() => fixture(undefined, {}, configured).loadRgbConfig()('utexo'), /mapping EVM chain IDs/);
});

test('failure after opening RGB Lib retains ownership until native cleanup succeeds', async () => {
  let failRead = true, failClose = true;
  const { load, native } = nativeWalletFixture(undefined, {
    capabilities: () => { if (failRead) throw new Error('Capability read failed'); },
    dispose: () => { if (failClose) throw new Error('Cleanup failed'); },
  });
  const rgb = load('RGB_L1');
  await rgb.start();
  assert.match(rgb.snapshot().error, /cleanup failed/);
  await rgb.start();
  assert.equal(native.nodes.length, 1);
  failClose = false;
  failRead = false;
  await rgb.start();
  assert.equal(rgb.snapshot().ready, true, rgb.snapshot().error);
});


const rgbKey = 'utexo-demo-wallet-v1-RGB_L1-utexo-default-taproot';
const rgbDirectory = 'file:///mock-wallet/wallet-connect-v1/RGB_L1/utexo/default/taproot';

test('Delete wallet closes RGB Lib, removes only its selected profile and creates fresh keys on Open', async () => {
  const { load, calls, native, savedKeys, client } = nativeWalletFixture(undefined, { regenerateRgbKeys: true });
  const rln = load();
  const rgb = load('RGB_L1');
  await rln.start();
  await rgb.start();
  await rgb.generateInvoice({ amount: '5', durationMinutes: '180' });
  const rlnState = rln.snapshot();
  const oldProvider = rgb.provider(context());
  await rgb.deleteWallet('utexo');
  assert.equal(rgb.snapshot().error, '');
  assert.equal(rgb.snapshot().ready, false);
  assert.equal(rgb.snapshot().busy, false);
  assert.equal(rgb.snapshot().address, '');
  assert.equal(rgb.snapshot().invoice, null);
  assert.equal(rgb.snapshot().btcBalance, null);
  assert.equal(rgb.snapshot().assets.length, 0);
  assert.equal(rgb.snapshot().transfers.length, 0);
  assert.equal(rgb.snapshot().sessions.length, 0);
  assert.equal(Object.keys(client.sessions).length, 0);
  assert.equal(rgb.snapshot().network, 'utexo');
  assert.match(rgb.snapshot().message, /Open wallet will create a new wallet/);
  assert.deepEqual(native.deletedDirectories, [rgbDirectory]);
  assert.deepEqual(native.deletedKeys, [rgbKey, `${rgbKey}-deleting`]);
  assert.ok(calls.indexOf('dispose') < calls.indexOf('deleteFiles'));
  assert.ok(calls.indexOf('deleteFiles') < calls.indexOf('deleteCredentials'));
  assert.equal(savedKeys.has(rgbKey), false);
  assert.equal(savedKeys.get(rgbKey.replace('utexo-default', 'regtest-default')), 'saved-rgb-mnemonic');
  assert.equal(rln.snapshot(), rlnState);
  assert.equal(native.nodes.length, 2, 'Deleting does not open another wallet');
  await rgb.start();
  assert.equal(rgb.snapshot().ready, true, rgb.snapshot().error);
  assert.equal(native.nodes.length, 3, 'Open must not reuse a disposed facade');
  assert.deepEqual(native.mnemonics, ['saved-rgb-mnemonic', 'new-rgb-mnemonic']);
  await assert.rejects(oldProvider.burnAsset({}), /network changed/);
  assert.equal(native.requests.length, 0);
});

test('Delete wallet also works before Open and without valid indexer configuration', async () => {
  const { load, native, savedKeys } = nativeWalletFixture(undefined, {
    env: { EXPO_PUBLIC_RGB_LIB_UTEXO_INDEXER_URL: '' },
  });
  const rgb = load('RGB_L1');
  await rgb.start();
  assert.match(rgb.snapshot().error, /INDEXER_URL/);
  await rgb.deleteWallet('utexo');
  assert.equal(rgb.snapshot().error, '');
  assert.equal(native.nodes.length, 0);
  assert.equal(savedKeys.has(rgbKey), false);
  assert.deepEqual(native.deletedDirectories, [rgbDirectory]);
});

test('a failed sbc profile can be deleted and replaced without opening it successfully', async () => {
  let oldProfile = true;
  const { load, native } = nativeWalletFixture(undefined, {
    regenerateRgbKeys: true,
    rgbInit: () => { if (oldProfile) throw new Error('WALLET_PROFILE_MISMATCH'); },
    deleteFiles: () => { oldProfile = false; },
  });
  const rgb = load('RGB_L1');
  await rgb.start();
  assert.equal(rgb.snapshot().error, 'WALLET_PROFILE_MISMATCH');
  await rgb.deleteWallet('utexo');
  assert.equal(rgb.snapshot().error, '');
  await rgb.start();
  assert.equal(rgb.snapshot().ready, true, rgb.snapshot().error);
  assert.deepEqual(native.mnemonics, ['saved-rgb-mnemonic', 'new-rgb-mnemonic']);
});

test('native cleanup failures retain keys/data until Delete wallet can close the handle', async () => {
  for (const failedOpen of [false, true]) {
    let failClose = true;
    const { load, native, savedKeys } = nativeWalletFixture(undefined, {
      rgbInit: () => { if (failedOpen) throw new Error('WALLET_PROFILE_MISMATCH'); },
      dispose: () => { if (failClose) throw new Error('Close failed'); },
    });
    const rgb = load('RGB_L1');
    await rgb.start();
    await rgb.deleteWallet('utexo');
    assert.match(rgb.snapshot().error, /Close failed/);
    assert.equal(rgb.snapshot().ready, false);
    assert.equal(native.deletedDirectories.length, 0);
    assert.equal(savedKeys.get(rgbKey), 'saved-rgb-mnemonic');
    await rgb.start();
    assert.equal(native.nodes.length, 1, 'No new native owner while cleanup fails');
    failClose = false;
    await rgb.deleteWallet('utexo');
    assert.equal(rgb.snapshot().error, '');
    assert.equal(savedKeys.has(rgbKey), false);
    assert.deepEqual(native.deletedDirectories, [rgbDirectory]);
  }
});

test('partial deletion stays blocked across app restart and can be retried safely', async () => {
  for (const failure of ['files', 'keys', 'marker']) {
    let failing = true;
    const options = {
      regenerateRgbKeys: true,
      deleteFiles: () => { if (failing && failure === 'files') throw new Error('Files unavailable'); },
      deleteKey: key => {
        if (failing && ((failure === 'keys' && key === rgbKey) ||
          (failure === 'marker' && key === `${rgbKey}-deleting`))) throw new Error('Keychain unavailable');
      },
    };
    const { load, savedKeys } = nativeWalletFixture(undefined, options);
    const rgb = load('RGB_L1');
    await rgb.start();
    await rgb.deleteWallet('utexo');
    assert.match(rgb.snapshot().error, /Could not delete wallet/);
    assert.equal(savedKeys.get(`${rgbKey}-deleting`), '1');
    if (failure !== 'marker') assert.equal(savedKeys.get(rgbKey), 'saved-rgb-mnemonic');
    const restarted = nativeWalletFixture(undefined, { ...options, savedKeys });
    const afterRestart = restarted.load('RGB_L1');
    await afterRestart.start();
    assert.match(afterRestart.snapshot().error, /deletion is incomplete/);
    assert.equal(restarted.native.nodes.length, 0);
    failing = false;
    await afterRestart.deleteWallet('utexo');
    assert.equal(afterRestart.snapshot().error, '');
    await afterRestart.start();
    assert.equal(afterRestart.snapshot().ready, true, afterRestart.snapshot().error);
    assert.deepEqual(restarted.native.mnemonics, ['new-rgb-mnemonic']);
  }
});

test('a failed deletion marker write or session disconnect leaves persisted wallet data intact', async () => {
  for (const failure of ['marker', 'session']) {
    const { load, client, native, savedKeys } = nativeWalletFixture(undefined, {
      writeKey: () => { if (failure === 'marker') throw new Error('Keychain unavailable'); },
    });
    const rgb = load('RGB_L1');
    await rgb.start();
    if (failure === 'session') client.disconnectSession = async () => { throw new Error('Relay unavailable'); };
    await rgb.deleteWallet('utexo');
    assert.match(rgb.snapshot().error, /Could not delete wallet/);
    assert.equal(native.deletedDirectories.length, 0);
    assert.equal(native.deletedKeys.length, 0);
    assert.equal(savedKeys.get(rgbKey), 'saved-rgb-mnemonic');
    assert.equal(savedKeys.has(`${rgbKey}-deleting`), false);
  }
});

test('Delete wallet is blocked during an operation or approval and rejects stale network confirmation', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { load, native } = nativeWalletFixture(undefined, { refresh: () => pending });
  const rgb = load('RGB_L1');
  await rgb.start();
  const refreshing = rgb.refresh();
  await rgb.deleteWallet('utexo');
  assert.equal(native.deletedDirectories.length, 0);
  release();
  await refreshing;
  const approval = rgb.confirm('Receive?', 'https://test.example', '5 units');
  await rgb.deleteWallet('utexo');
  assert.equal(native.deletedDirectories.length, 0);
  rgb.snapshot().prompt.resolve(false);
  await approval;
  await rgb.selectNetwork('regtest');
  await rgb.deleteWallet('utexo');
  assert.match(rgb.snapshot().error, /Network changed/);
  assert.equal(rgb.snapshot().ready, true);
  assert.equal(native.deletedDirectories.length, 0);
});

test('deletion revokes queued website requests and blocks concurrent Open, Delete and network switching', async () => {
  const { load, native } = nativeWalletFixture();
  const rgb = load('RGB_L1');
  await rgb.start();
  let release;
  rgb.queue = new Promise(resolve => { release = resolve; });
  const provider = rgb.provider(context());
  const queued = assert.rejects(provider.burnAsset({}), /network changed/);
  const deleting = rgb.deleteWallet('utexo');
  await new Promise(resolve => setImmediate(resolve));
  await rgb.start();
  await rgb.deleteWallet('utexo');
  await rgb.selectNetwork('regtest');
  assert.equal(native.nodes.length, 1);
  assert.equal(native.deletedDirectories.length, 0);
  release();
  await Promise.all([deleting, queued]);
  assert.equal(rgb.snapshot().error, '');
  assert.equal(rgb.snapshot().network, 'utexo');
  assert.equal(native.requests.length, 0);
  assert.deepEqual(native.deletedDirectories, [rgbDirectory]);
});


test('local RGB Lib burns commit V1 destinations and recover from their separate journal', async (t) => {
  const { load, native, storage } = nativeWalletFixture(undefined, { burnAvailable: true });
  const rgb = load('RGB_L1');
  await rgb.start();
  t.after(() => rgb.snapshot().prompt?.resolve(false));
  const form = { ...localBurnForm, payoutChainId: 'eip155:42161' };
  const task = rgb.burnAsset(form);
  const prompt = await waitForWalletPrompt(rgb);
  assert.ok(prompt.details.includes(form.payoutAddress));
  assert.match(prompt.details, /Arbitrum/);
  prompt.resolve(true);
  const result = await task;
  assert.equal(result.state, 'complete', rgb.snapshot().error);
  const destination = { version: 1, destinationChainId: 42161, dstEid: 0, recipient: form.payoutAddress };
  assert.deepEqual(JSON.parse(JSON.stringify(result.metadata.burnDestination)), destination);
  assert.equal(native.burns[0].burnRecipient, burnDestinationHash(destination).slice(2));
  const key = 'utexo-burn-journal-v1:rgb:utexo:RGB-L1-saved-node-pubkey';
  assert.equal(JSON.parse(storage.get(key))[0].state, 'complete');
  assert.equal(storage.has('utexo-burn-journal-v1:rgb:utexo:saved-node-pubkey'), false);
  const restart = nativeWalletFixture(undefined, { burnAvailable: true });
  restart.storage.set(key, storage.get(key));
  const reopened = restart.load('RGB_L1');
  await reopened.start();
  assert.equal(reopened.snapshot().burns[0].result.txid, result.result.txid);
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.snapshot().burns[0].metadata.burnDestination)), destination);
  assert.equal(restart.native.burns.length, 0, 'Reopening must not reburn');
  const unsupported = await reopened.burnAsset({ ...form, payoutChainId: 'eip155:56' });
  assert.equal(unsupported, undefined);
  assert.match(reopened.snapshot().error, /Unsupported V1 payout route/);
  assert.equal(reopened.snapshot().prompt, null);
});
