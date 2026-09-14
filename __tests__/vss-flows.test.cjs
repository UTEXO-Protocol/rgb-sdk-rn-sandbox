/* global __dirname */
// Run with: node --test __tests__/vss-flows.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(relativePath, dependencies, clock, globals = {}) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  vm.runInNewContext(outputText, {
    exports,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    console: { log() {}, warn() {}, error() {} },
    Date: { now: () => clock.now },
    process: { env: { EXPO_PUBLIC_UTEXO_VSS_URL: 'https://vss.example.test/vss' } },
    ...globals,
  });
  return exports;
}

for (const failure of [null, 'unlock', 'backup']) {
  test(`UTEXO init/unlock/backup: ${failure ?? 'success'}`, async () => {
    const events = [];
    const clock = { now: 1000 };
    const core = load('utils/flow-core.ts', {}, clock);
    const vssUrl = 'https://vss-server.utexo.com/vss';
    class Wallet {
      constructor(params) {
        assert.equal(params.network, 'utexo');
        assert.equal(params.vssUrl, vssUrl);
        assert.equal(params.vssAllowHttp, false);
        events.push('wallet');
      }
      async init() { events.push('init'); }
      async unlock() {
        events.push('unlock');
        if (failure === 'unlock') throw new Error('Unlock failed');
      }
      async backupNow() {
        events.push('backupNow');
        if (failure === 'backup') throw new Error('VSS error: Server error: Unknown Server Error');
        return 1;
      }
      async destroy() { events.push('destroy'); }
    }
    const flow = load('flows/vss/runRlnUtexoVssFlow.ts', {
      '@utexo/rgb-sdk-rn': { UTEXOWallet: Wallet, createWallet: async () => ({ mnemonic: 'seed' }), PasswordRLNSigner: class {} },
      'expo-file-system/legacy': { documentDirectory: 'file:///test/', makeDirectoryAsync: async () => {}, deleteAsync: async () => assert.fail('Probe must not wipe state') },
      '@/utils/bitcoin-node': { sendToAddressUtexo: async () => assert.fail('Probe must not request funding') },
      '@/utils/env': { buildUtexoConfig: () => ({ network: 'utexo', unlockParams: {} }) },
      '@/utils/flow-core': core,
    }, clock, {
      process: { env: { EXPO_PUBLIC_UTEXO_VSS_URL: vssUrl, EXPO_PUBLIC_UTEXO_VSS_BACKUP_ONLY: '1' } },
    });
    const result = await flow.runRlnUtexoVssFlow();
    assert.equal(result.success, failure === null);
    assert.deepEqual(events, ['wallet', 'init', 'unlock',
      ...(failure === 'unlock' ? [] : ['backupNow']), 'destroy']);
    if (failure) assert.equal(result.error.lastStep, failure === 'unlock' ? 'vssCreateWallets' : 'vssBackupNow');
    if (failure === 'backup') assert.match(result.error.message, /Unknown Server Error/);
  });
}

for (const name of ['runRlnVssFlow', 'runRlnUtexoVssFlow']) {
  for (const failure of [null, 'unlock', 'backup', 'version', 'pubkey', 'channel', 'capacity', 'asset', 'balance', 'funding', 'confirmation', 'channelTimeout']) {
    test(`${name}: ${failure ?? 'successful restore'}`, async () => {
      const clock = { now: 1000 };
      const events = [];
      const wallets = [];
      class Wallet {
        constructor(params, signer) {
          this.params = params;
          this.signer = signer;
          this.restored = params.storageDirPath.includes('restore');
          this.colored = 0;
          wallets.push(this);
        }
        async init() {}
        async unlock() {
          if (failure === 'unlock') throw new Error('VSS I/O');
          if (this.restored) events.push('restore');
        }
        async getNodeInfo() {
          return { pubkey: this.restored && failure === 'pubkey' ? 'wrong' : 'original', numUsableChannels: failure === 'channelTimeout' ? 0 : 1 };
        }
        async getAddress() { return 'address'; }
        async syncWallet() {}
        async getBtcBalance() {
          return { vanilla: { settled: failure === 'funding' ? 0 : 100000000, spendable: 100000000 }, colored: { settled: this.colored } };
        }
        async createUtxos() { if (failure !== 'confirmation') this.colored = 97500; }
        async issueAssetNia() { return { assetId: 'asset' }; }
        async refreshWallet() {}
        async getAssetBalance() { return { settled: this.restored && failure === 'balance' ? 0 : 500, spendable: 500 }; }
        async connectPeer() {}
        async openChannel(params) { this.capacity = params.capacitySat; return { temporaryChannelId: 'temporary' }; }
        async listChannels() {
          return [{ channelId: this.restored && failure === 'channel' ? 'different' : 'channel', ready: true,
            capacitySat: this.restored ? wallets[0].capacity + (failure === 'capacity' ? 1 : 0) : this.capacity }];
        }
        async listAssets() { return { nia: failure === 'asset' ? [] : [{ assetId: 'asset' }] }; }
        async backupNow() {
          if (failure === 'backup') throw new Error('Backup failed');
          events.push('backup');
          return failure === 'version' ? NaN : 1;
        }
        async shutdown() { events.push('shutdown'); }
        async vssClearFence() { events.push('fence'); }
        async destroy() {}
      }
      const core = load('utils/flow-core.ts', {}, clock);
      core.sleep = async (ms) => { clock.now += ms; };
      const config = () => ({ network: 'regtest', unlockParams: {} });
      const flow = load(`flows/vss/${name}.ts`, {
        '@utexo/rgb-sdk-rn': { UTEXOWallet: Wallet, createWallet: async () => ({ mnemonic: 'seed' }), PasswordRLNSigner: class {} },
        'expo-file-system/legacy': { documentDirectory: 'file:///test/', makeDirectoryAsync: async () => {}, deleteAsync: async () => { events.push('delete'); } },
        '@/utils/bitcoin-node': { mine: async () => {}, sendToAddress: async () => 'txid', sendToAddressUtexo: async () => 'txid' },
        '@/utils/env': { buildUtexoConfig: config, buildRegtestConfig: config, readEnv: () => 'https://vss.example.test/vss' },
        '@/utils/flow-core': core,
      }, clock);
      const result = await flow[name]();
      assert.equal(result.success, failure === null, JSON.stringify(result.error));
      assert.equal(wallets[0].params.vssAllowEmptyRestore, true);
      if (!failure) {
        assert.deepEqual(events, ['backup', 'shutdown', 'delete', 'fence', 'restore']);
        assert.equal(wallets[2].params.vssAllowEmptyRestore, false);
      } else {
        assert.ok(result.error.lastStep);
        if (['unlock', 'backup', 'version', 'funding', 'confirmation', 'channelTimeout'].includes(failure)) {
          assert.ok(!events.includes('delete'), 'Never wipe before a successful backup');
        }
        if (failure === 'unlock') assert.equal(result.error.lastStep, 'vssCreateWallets');
        if (['backup', 'version'].includes(failure)) assert.equal(result.error.lastStep, 'vssBackupNow');
      }
    });
  }
}
