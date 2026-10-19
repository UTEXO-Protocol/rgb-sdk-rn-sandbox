import { localBfaBurnDestination, burnDestinationHash } from '@utexo/rgb-sdk-rn';
import { BurnOperations, UTEXOWallet } from '@utexo/rgb-sdk-rn';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { formatJsonRpcError } from '@walletconnect/jsonrpc-utils';
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

test('burn history reports the burned amount, never its change, through the real SDK provider', async () => {
  const assetId = 'rgb:burn-amount';
  const txid = 'c935a70610b2fafde779ba7f05fe211e8923a86dd6fd934542345ce4eb74c027';
  const records = [
    { idx: 1, txid, kind: 'Burn', status: 'Settled',
      requestedAssignment: 'Fungible(100000)',
      assignments: ['Fungible(900000)'] },
    { idx: 2, txid: 'ab'.repeat(32), kind: 'Burn', status: 'Settled',
      requestedAssignment: 'Fungible(1000000)', assignments: [] },
    { idx: 3, txid: 'cd'.repeat(32), kind: 'Burn', status: 'Settled',
      assignments: ['Fungible(900000)'] },
    { idx: 4, txid: 'ef'.repeat(32), kind: 'ReceiveBlind', status: 'Settled',
      assignments: ['Fungible(1000000)'] },
  ];
  let reads = 0;
  const wallet = {
    isDisposed: () => false,
    async listTransfers(id) { assert.equal(this, wallet); assert.equal(id, assetId); reads++; return UTEXOWallet.prototype.listTransfers.call({ rln: { rlnListTransfers: async () => records } }, id); },
    async refreshWallet() { assert.equal(this, wallet); },
  };
  const abort = new AbortController();
  const provider = createDemoRgbProvider(wallet, {
    context: { origin: 'https://bridge.example', signal: abort.signal, assertAuthorized() {} },
    confirm: async () => { throw new Error('Reading history must not request a burn'); },
    run: (_method, _args, action) => action(),
  });
  const transfers = await provider.listTransfers(assetId);
  assert.equal(transfers[0].amount, 100000);
  assert.equal(transfers[0].amountBaseUnits, '100000');
  assert.equal(transfers[0].txid, txid);
  assert.equal(transfers[1].amountBaseUnits, '1000000', 'Full burn with no change');
  assert.equal(transfers[2].amount, undefined, 'Never use change if the burn amount is unknown');
  assert.equal(transfers[2].amountBaseUnits, undefined);
  assert.equal(transfers[3].amount, 1000000, 'Receiving is unchanged');
  assert.equal(records[0].assignments[0], 'Fungible(900000)', 'Do not modify native transfer data');
  assert.equal(reads, 1, 'No extra native read to correct the mapping');
  const status = await provider.getTransferStatus(txid, assetId);
  assert.equal(status.transfer.amount, 100000, 'Fallback status uses the same corrected mapping');
  abort.abort();
  await assert.rejects(provider.listTransfers(assetId), { code: 'NOT_ENABLED' });
  assert.equal(reads, 2, 'A revoked session cannot read native history');
});

test('the installed SDK supplies exact burn amounts through the demo without a journal workaround', async () => {
  const assetId = 'rgb:burn-amount', txid = 'c9'.repeat(32);
  const raw = [
    { idx: 1, txid, kind: 'Burn', status: 'Settled',
      requestedAssignment: 'Fungible(100000)', assignments: ['Fungible(900000)'] },
    { idx: 2, txid: 'ab'.repeat(32), kind: 'Burn', status: 'Settled',
      requestedAssignment: 'Fungible(18446744073709551615)', assignments: [] },
    { idx: 3, txid: 'ef'.repeat(32), kind: 'Burn', status: 'Settled', assignments: ['Fungible(42)'] },
  ];
  const rln = { async rlnListTransfers(id) { assert.equal(id, assetId); return raw; } };
  const wallet = { isDisposed: () => false,
    listTransfers: asset => UTEXOWallet.prototype.listTransfers.call({ rln }, asset) };
  const sdk = await wallet.listTransfers(assetId);
  assert.equal(sdk[0].requestedAssignment.amount, 100000);
  assert.equal(sdk[0].assignments[0].amount, 900000);
  assert.equal(sdk[0].amountBaseUnits, '100000');
  const provider = createDemoRgbProvider(wallet, {
    context: { origin: 'https://bridge.example', network: 'utexo', signal: new AbortController().signal, assertAuthorized() {} },
    confirm: async () => { throw new Error('Reading history must not request a burn'); },
    run: (_method, _args, action) => action(),
  });
  const transfers = await provider.listTransfers(assetId);
  assert.equal(transfers[0].amount, 100000);
  assert.equal(transfers[0].amountBaseUnits, '100000');
  assert.equal(transfers[1].amount, undefined);
  assert.equal(transfers[1].amountBaseUnits, '18446744073709551615');
  assert.equal(transfers[2].amountBaseUnits, undefined);
  assert.equal(transfers.length, raw.length);
});
const { createDemoRgbProvider } = module.exports;
for (const method of ['blindReceive', 'witnessReceive']) {
  test(`demo ${method} forwards an open invoice with a 24-hour default and explicit TTL`, async () => {
    const calls = [];
    const approvals = [];
    const wallet = {
      isDisposed: () => false,
      [method]: async (params) => {
        calls.push(params);
        return { invoice: 'rgb:invoice', recipientId: 'receiver', expirationTimestamp: 1234 };
      },
    };
    const provider = createDemoRgbProvider(wallet, {
      context: { origin: 'https://bridge.example', signal: new AbortController().signal, assertAuthorized() {} },
      confirm: async (request) => { approvals.push(request); return true; },
      run: (_method, _args, action) => action(),
    });
    await provider[method]();
    await provider[method]({ durationSeconds: 90 });
    assert.deepEqual(calls, [86400, 90].map(durationSeconds => ({
      assetId: undefined, amount: undefined, durationSeconds, minConfirmations: 3,
    })));
    assert.deepEqual(approvals.map(request => request.params), calls);
  });
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

for (const [chainId, address] of [
  ['eip155:42161', '0x' + '12'.repeat(20)],
  ['eip155:1', '0x' + '12'.repeat(20)],
  ['eip155:137', '0x' + '12'.repeat(20)],
  ['eip155:9745', '0x' + '12'.repeat(20)],
  ['tron:728126428', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
]) {
test(`packed adapter connects the wallet and returns a complete V1 burn proof for ${chainId}`, async (t) => {
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
      // WalletKit normalizes reserved JSON-RPC errors; -32603 loses its details.
      const value = JSON.parse(JSON.stringify(response.error
        ? formatJsonRpcError(response.id, response.error)
        : response));
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
    async getAssetBalance() {
      throw Object.assign(new Error('Unknown RGB contract ID'), { code: 'NotFound' });
    },
    blindReceive: async (args) => ({
      invoice: 'rgb:invoice',
      recipientId: 'bcrt:utxob:receiver',
      expirationTimestamp: Math.floor(Date.now() / 1000) + args.durationSeconds,
    }),
    listAssets: async () => ({ bfa: [{ assetId, name: 'Mock', precision: 0 }] }),
    async burn(params) {
      assert.equal(records[0].state, 'pending');
      assert.equal(params.amount, '5');
      assert.equal(params.burnRecipient, burnDestinationHash(destination));
      burns++;
      return { txid, batchTransferIdx: 8 };
    },
    async getConsignment() {
      proofReads++;
      return bytes.toString('base64');
    },
    listTransfers: asset => UTEXOWallet.prototype.listTransfers.call({ rln: {
      rlnListTransfers: async () => [{ txid, idx: 3, kind: 'Burn', status: 'Settled',
        requestedAssignment: 'Fungible(5)', assignments: ['Fungible(95)'] }],
    } }, asset),
    listTransactionsByTxid: async () => [{ txid, confirmationTime: { height: 100 } }],
    getNetworkInfo: async () => ({ blockHeight: 102 }),
    refreshWallet: async () => {},
  };
  const destination = localBfaBurnDestination({ chainId, address });
  const operations = new BurnOperations(native, { readAll: async () => records, write: async record => { records[0] = record; } }, { destinationV1: true });
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
          operations,
        },
      }),
  });
  t.after(() => host.dispose());
  const connection = await connectWalletConnect({
    client: dapp,
    network,
    methods: ['blindReceive', 'burnAsset', 'getConsignment', 'getTransferStatus', 'listTransfers', 'getAssetBalance'],
  });
  await host.pair(connection.uri);
  const provider = await connection.approval();
  t.after(() => provider.dispose());
  await provider.enable();
  await assert.rejects(provider.getAssetBalance(assetId), {
    code: 'ASSET_NOT_FOUND',
    message: 'This asset is not in this wallet yet. Receive it first, then refresh your balance.',
  });
  assert.equal(burns, 0);
  assert.equal(records.length, 0);
  assert.equal(confirmations.length, 0);
  native.getAssetBalance = async () => ({ settled: 10, future: 10, spendable: 10 });
  assert.equal((await provider.getAssetBalance(assetId)).balance, 10);
  assert.equal((await provider.blindReceive({ amount: 5 })).invoice, 'rgb:invoice');
  const result = await provider.burnAsset({
    network,
    assetId,
    amount: '5',
    burnRecipient: { chainId, address },
    burnDestination: destination,
    feeRate: 2,
    minConfirmations: 3,
  });
  assert.equal(result.transferId, txid);
  assert.deepEqual(result.burnDestination, destination);
  assert.equal((await provider.getInfo()).burnDestinationVersion, 1);
  assert.deepEqual((await provider.getInfo()).burnDestinationRoutes, [{ chainId: 'eip155:42161', dstEid: 0 }, { chainId: 'eip155:1', dstEid: 30101 }, { chainId: 'eip155:137', dstEid: 30109 }, { chainId: 'eip155:9745', dstEid: 30383 }, { chainId: 'tron:728126428', dstEid: 30420 }]);
  assert.equal(result.requestId, undefined);
  assert.equal(requests.find((r) => r.method === 'rgb_burnAsset').params[0].requestId, undefined);
  assert.ok(records[0].id, 'The journal keeps its private identifier');
  const history = await provider.listTransfers(assetId);
  assert.equal(history[0].amount, 5);
  assert.equal(history[0].amountBaseUnits, '5', 'Exact burn amount survives the WalletConnect adapter');
  const proof = await provider.getConsignment({ assetId, txid });
  assert.deepEqual(Buffer.from(proof.data, 'base64'), bytes);
  assert.equal(proof.byteLength, bytes.length);
  assert.equal(requests.filter((r) => r.method === 'rgb_getConsignment').length, 3);
  const status = await provider.getTransferStatus(txid, assetId);
  assert.equal(status.status, 'Settled');
  assert.equal(status.transfer.blockHeight, 100);
  assert.deepEqual(status.transfer.burnDestination, destination);
  assert.equal(status.transfer.requestId, undefined);
  assert.equal(burns, 1);
  assert.equal(proofReads, 1);
  assert.deepEqual(confirmations, ['blindReceive', 'burnAsset']);
  await provider.disconnect();
});

}

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
        operations: new BurnOperations({}, { readAll: async () => [], write: async () => {} }),
      },
    },
  );
  await assert.rejects(provider.burnAsset(args), { code: 'NOT_ENABLED' });
  assert.equal(burns, 0);
});
