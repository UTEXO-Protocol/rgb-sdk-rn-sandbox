import { BurnOperations } from '@utexo/rgb-sdk-rn';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { connectWalletConnect, createWalletConnectWallet } from '@utexo/webrgb-walletconnect';
import { WebRgbProvider, WEBRGB_READ_METHODS } from '@utexo/rgb-sdk-rn/webrgb';

const source = ts.transpileModule(
  readFileSync(new URL('../utils/wallet/provider.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  },
).outputText;
const module = { exports: {} };
vm.runInNewContext(source, {
  exports: module.exports,
  crypto: globalThis.crypto,
  Uint8Array,
  require: (name) => {
    assert.equal(name, '@utexo/rgb-sdk-rn/webrgb');
    return { WebRgbProvider };
  },
});
const { createDemoRgbProvider } = module.exports;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

test('packed adapter connects the demo wallet provider, creates an invoice and returns a complete burn proof', async (t) => {
  const approved = deferred(),
    events = new EventEmitter(),
    dappEvents = new EventEmitter();
  const pending = new Map(),
    sessions = new Map(),
    requests = [],
    records = [],
    confirmations = [];
  let proposal,
    id = 0,
    burns = 0,
    proofReads = 0;
  const assetId = 'rgb:mock',
    txid = 'ab'.repeat(32),
    network = 'regtest';
  const bytes = Buffer.alloc(100000, 37);
  const dapp = {
    on: dappEvents.on.bind(dappEvents),
    off: dappEvents.off.bind(dappEvents),
    session: { get: (topic) => sessions.get(topic), getAll: () => [...sessions.values()] },
    core: { pairing: { async disconnect() {} } },
    async connect(params) {
      proposal = {
        id: 1,
        params: {
          ...params,
          expiryTimestamp: Math.floor(Date.now() / 1000) + 300,
          proposer: { metadata: { name: 'Mint UI', url: 'https://mint.example' } },
        },
      };
      return {
        uri: `wc:${'12'.repeat(32)}@2?relay-protocol=irn&symKey=${'34'.repeat(32)}`,
        approval: () => approved.promise,
      };
    },
    async request({ topic, chainId, request }) {
      const task = deferred(),
        key = ++id;
      pending.set(key, task);
      requests.push(request);
      events.emit(
        'session_request',
        JSON.parse(
          JSON.stringify({
            id: key,
            topic,
            params: {
              chainId,
              request: { ...request, expiryTimestamp: Math.floor(Date.now() / 1000) + 300 },
            },
          }),
        ),
      );
      return task.promise;
    },
    async disconnect({ topic }) {
      sessions.delete(topic);
      events.emit('session_delete', { topic });
      dappEvents.emit('session_delete', { topic });
    },
  };
  const walletKit = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    core: { expirer: new EventEmitter() },
    getActiveSessions: () => Object.fromEntries(sessions),
    async pair() {
      events.emit('session_proposal', proposal);
    },
    async approveSession({ namespaces, sessionProperties }) {
      const session = {
        topic: 'poc-test',
        expiry: Math.floor(Date.now() / 1000) + 3600,
        namespaces,
        sessionProperties,
        peer: proposal.params.proposer,
      };
      sessions.set(session.topic, session);
      approved.resolve(session);
      return session;
    },
    async rejectSession({ reason }) {
      approved.reject(reason);
    },
    async respondSessionRequest({ response }) {
      const value = JSON.parse(JSON.stringify(response));
      if (value.error) pending.get(value.id).reject(value.error);
      else pending.get(value.id).resolve(value.result);
    },
    async emitSessionEvent() {},
    disconnectSession: dapp.disconnect,
  };
  const native = {
    isDisposed: () => false,
    getNetwork: () => network,
    getBfaCapabilities: async () => ({ burn: true, consignment: true }),
    blindReceive: async (args) => ({
      invoice: 'rgb:invoice',
      recipientId: 'bcrt:utxob:receiver',
      expirationTimestamp: Math.floor(Date.now() / 1000) + args.durationSeconds,
    }),
    listAssets: async () => ({ bfa: [{ assetId, name: 'Mock', precision: 0 }] }),
    async burn(params) {
      assert.equal(records[0].state, 'pending');
      assert.equal(params.amount, '5');
      assert.equal(params.burnRecipient, '0'.repeat(24) + '12'.repeat(20));
      burns++;
      return { txid, batchTransferIdx: 8 };
    },
    async getConsignment() {
      proofReads++;
      return bytes.toString('base64');
    },
    listTransfers: async () => [{ txid, idx: 3, kind: 'Burn', status: 'Settled', assignments: [] }],
    listTransactionsByTxid: async () => [{ txid, confirmationTime: { height: 100 } }],
    getNetworkInfo: async () => ({ blockHeight: 102 }),
    refreshWallet: async () => {},
  };
  const operations = new BurnOperations(native, { readAll: async () => records, write: async record => { records[0] = record; } });
  const host = createWalletConnectWallet({
    client: walletKit,
    network,
    account: 'test-wallet',
    methods: [...WEBRGB_READ_METHODS, 'burnAsset', 'getConsignment'],
    approveSession: async () => true,
    getProvider: (context) =>
      createDemoRgbProvider(native, {
        context,
        confirm: async (request) => {
          confirmations.push(request.method);
          return true;
        },
        run: (_method, _args, action) => action(),
        burn: {
          allowedPayoutChainIds: ['eip155:31337'],
          operations,
        },
      }),
  });
  t.after(() => host.dispose());
  const connection = await connectWalletConnect({
    client: dapp,
    network,
    methods: ['blindReceive', 'burnAsset', 'getConsignment', 'getTransferStatus'],
  });
  await host.pair(connection.uri);
  const provider = await connection.approval();
  t.after(() => provider.dispose());
  await provider.enable();
  assert.equal((await provider.blindReceive({ amount: 5 })).invoice, 'rgb:invoice');
  const result = await provider.burnAsset({
    network,
    assetId,
    amount: '5',
    burnRecipient: { chainId: 'eip155:31337', address: '0x' + '12'.repeat(20) },
    feeRate: 2,
    minConfirmations: 3,
  });
  assert.equal(result.transferId, txid);
  assert.equal(result.requestId, undefined);
  assert.equal(requests.find((r) => r.method === 'rgb_burnAsset').params[0].requestId, undefined);
  assert.ok(records[0].id, 'The journal keeps its private identifier');
  const proof = await provider.getConsignment({ assetId, txid });
  assert.deepEqual(Buffer.from(proof.data, 'base64'), bytes);
  assert.equal(proof.byteLength, bytes.length);
  assert.equal(requests.filter((r) => r.method === 'rgb_getConsignment').length, 3);
  const status = await provider.getTransferStatus(txid, assetId);
  assert.equal(status.status, 'Settled');
  assert.equal(status.transfer.blockHeight, 100);
  assert.equal(status.transfer.requestId, undefined);
  assert.equal(burns, 1);
  assert.equal(proofReads, 1);
  assert.deepEqual(confirmations, ['blindReceive', 'burnAsset']);
  await provider.disconnect();
});

test('revoking a request during confirmation prevents the SDK from starting burn', async () => {
  let authorized = true,
    burns = 0;
  const args = {
    network: 'regtest',
    assetId: 'rgb:mock',
    amount: '5',
    burnRecipient: { chainId: 'eip155:31337', address: '0x' + '12'.repeat(20) },
  };
  const context = {
    origin: 'https://mint.example',
    signal: new AbortController().signal,
    assertAuthorized() {
      if (!authorized) throw Object.assign(new Error('Request expired'), { code: 'NOT_ENABLED' });
    },
  };
  const provider = createDemoRgbProvider(
    {
      isDisposed: () => false,
      getNetwork: () => 'regtest',
      getBfaCapabilities: async () => ({ burn: true, consignment: true }),
      listAssets: async () => ({ bfa: [{ assetId: args.assetId }] }),
      burn: async () => {
        burns++;
      },
    },
    {
      context,
      confirm: async () => {
        authorized = false;
        return true;
      },
      run: (_method, _args, action) => action(),
      burn: {
        allowedPayoutChainIds: ['eip155:31337'],
        operations: new BurnOperations({}, { readAll: async () => [], write: async () => {} }),
      },
    },
  );
  await assert.rejects(provider.burnAsset(args), { code: 'NOT_ENABLED' });
  assert.equal(burns, 0);
});
