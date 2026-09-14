/* global __dirname */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

for (const failure of [null, 'backup', 'balance', 'missingChannel', 'fund']) {
  test(`H with injected environment: ${failure ?? 'full restore and close'}`, async () => {
    const events = [];
    let boots = 0;
    const wallets = [];
    const boot = async (opts) => {
      const restored = boots++ > 0;
      let colored = 0;
      let closed = false;
      const wallet = {
        getAddress: async () => 'address', syncWallet: async () => {}, refreshWallet: async () => {},
        getBtcBalance: async () => ({ vanilla: { settled: 1200000, spendable: closed ? 1300000 : 1200000 }, colored: { settled: colored } }),
        createUtxos: async () => { colored = 162500; },
        issueAssetNia: async () => ({ assetId: 'asset', issuedSupply: 400 }),
        connectPeer: async () => {}, openChannel: async () => {},
        listChannels: async () => restored && failure === 'missingChannel' ? [] : [{ channelId: 'channel', peerPubkey: 'peer', capacitySat: 100000, ready: true, isUsable: true, localBalanceMsat: restored && failure === 'balance' ? 1 : 50000000 }],
        createLightningInvoice: async () => ({ lnInvoice: 'invoice' }),
        getLightningReceiveStatus: async () => 'Succeeded',
        getNodeInfo: async () => ({ pubkey: '02' + 'a'.repeat(64) }),
        getAssetBalance: async () => ({ settled: 400 }),
        listAssets: async () => ({ nia: [{ assetId: 'asset' }] }),
        listTransfers: async () => [{}], listTransactions: async () => [{ txid: 'a'.repeat(64) }],
        backupNow: async () => { if (failure === 'backup') throw Error('backup'); events.push('backup'); return 1; },
        shutdown: async () => { events.push('shutdown'); },
        closeChannel: async () => { closed = true; events.push('close'); },
        destroy: async () => { events.push(restored ? 'destroy-restored' : 'destroy-original'); },
      };
      wallets.push(opts);
      return { wallet, mnemonic: 'seed', storageDirUri: 'dir' };
    };
    const deps = {
      'expo-file-system/legacy': { deleteAsync: async () => { events.push('wipe'); } },
      '@utexo/rgb-sdk-core/conformance': { expectFields() {}, expectNoWireKeys() {}, HEX_32: /^[a-f0-9]{64}$/, HEX_PUBKEY: /^[a-f0-9]{66}$/ },
      '@/utils/bitcoin-node': { mine: async () => { throw Error('Default mining must not bypass the injected environment'); }, sendToAddress: async () => { throw Error('Default funding must not bypass the injected environment'); } },
      '../harness': { assert: (v, m) => assert.ok(v, m), assertEq: assert.equal, bootWallet: boot, hostUrl: (u) => u, hostAddr: () => 'unused', waitFor: async (_label, fn) => { const v = await fn(); assert.ok(v); return v; } },
      '../marker': { emitLog() {} },
    };
    const exports = {};
    const source = fs.readFileSync(path.join(__dirname, '../e2e/scenarios/h-restore.ts'), 'utf8');
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: (key) => { assert.ok(key in deps); return deps[key]; } });
    const ctx = { fx: { VSS_URL: 'https://vss.test', FAUCET_PUBKEY: 'peer' }, step: async (_name, fn) => fn() };
    const promise = exports.scenarioH(ctx, { boot, fund: async () => { if (failure === 'fund') throw Error('fund'); }, mine: async () => {}, payInvoice: async () => { events.push('pay'); }, peerUri: 'peer@127.0.0.1:1234', confirmationPoll: { attempts: 1, delayMs: 0 } });
    if (failure) await assert.rejects(promise);
    else {
      await promise;
      assert.deepEqual(events, ['pay', 'backup', 'shutdown', 'wipe', 'close', 'destroy-restored']);
      assert.equal(wallets[0].allowEmptyRestore, true);
      assert.equal(wallets[1].allowEmptyRestore, false);
      assert.equal(wallets[1].mnemonic, 'seed');
    }
    if (['fund', 'backup'].includes(failure)) {
      assert.ok(!events.includes('wipe'));
      assert.ok(events.includes('destroy-original'));
    }
    if (['balance', 'missingChannel'].includes(failure)) {
      assert.ok(!events.includes('close'));
      assert.ok(events.includes('destroy-restored'));
    }
  });
}
