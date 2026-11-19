/**
 * Scenario L2 — RGB_L1 asset issuance and on-chain RGB sends.
 *
 * The sender issues an NIA asset and sends it twice: to a blinded UTXO and to
 * a witness (address-style) invoice. Each send must settle on both sides and
 * move exactly the invoiced amount. Leaves `niaAssetId` for L3/L4.
 *
 * Before and after the witness send it also calls `getReceivedMint` on the real
 * engine, natively and through WebRGB. An NIA receive is not a BFA mint, so the
 * answer is "no mint" (`undefined` / `null`), and the WebRGB checks on the
 * invoice (own invoice, names an asset) run against real wallet history. A real
 * mint needs the EVM bridge, which the local stack does not run.
 */
import { expectFields, expectNoWireKeys, HEX_32 } from '@utexo/rgb-sdk-core/conformance';
import { BurnOperations, WebRgbProvider } from '@utexo/rgb-sdk/webrgb';

import { assert, assertEq } from '../harness';
import { settle, settledBalance, type RgbLibScenarioContext } from '../rgb-lib-harness';

const ISSUED = 10_000;
const BLIND_AMOUNT = 1_000;
const WITNESS_AMOUNT = 500;
const WITNESS_SATS = 1_000;

/** A WebRGB session over one wallet; getReceivedMint never prompts. */
function webRgb(wallet: RgbLibScenarioContext['receiver']['wallet']) {
  return new WebRgbProvider(wallet, {
    origin: 'https://e2e.example',
    sessionApproved: true,
    confirm: async () => {
      throw new Error('getReceivedMint must not ask the user');
    },
    burn: { operations: new BurnOperations(wallet, { readAll: async () => [], write: async () => undefined }) },
  });
}

async function rejectCode(what: string, fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  assert(false, `${what} should have been rejected`);
  return '';
}

export async function scenarioL2(ctx: RgbLibScenarioContext): Promise<void> {
  const { step } = ctx;
  const sender = ctx.sender.wallet;
  const receiver = ctx.receiver.wallet;

  const asset = await step(
    'issueAssetNia',
    () => sender.issueAssetNia({ ticker: 'L2NIA', name: 'L2 Test Asset', amounts: [ISSUED], precision: 0 }),
    (a) => a
  );
  expectFields(asset, {
    assetId: { type: 'string', pattern: /^rgb:/ },
    ticker: { oneOf: ['L2NIA'] },
    issuedSupply: { oneOf: [ISSUED] },
    'balance.settled': { oneOf: [ISSUED] },
  });
  expectNoWireKeys(asset);
  ctx.state.niaAssetId = asset.assetId;

  await step('listAssets has the asset', async () => {
    const assets = await sender.listAssets();
    assert(assets.nia.some((a) => a.assetId === asset.assetId), 'listAssets.nia must include the issued asset');
    return assets.nia.length;
  }, (n) => ({ nia: n }));

  // ── blind receive ──────────────────────────────────────────────────────────
  const blind = await step(
    'receiver blindReceive',
    // No assetId: a wallet that has never seen the asset cannot name it (AssetNotFound).
    () => receiver.blindReceive({ amount: BLIND_AMOUNT }),
    (r) => r
  );
  const decoded = await step('decodeRGBInvoice', () => sender.decodeRGBInvoice({ invoice: blind.invoice }), (d) => d);
  assertEq(decoded.recipientId, blind.recipientId, 'decoded recipientId');
  assertEq(decoded.assignment.amount, BLIND_AMOUNT, 'decoded amount');
  assertEq(decoded.network, 'regtest', 'decoded network');
  assert(decoded.transportEndpoints.length > 0, 'invoice must carry the proxy endpoint');

  const blindSend = await step(
    'onchainSend (blind)',
    () => sender.onchainSend({ invoice: blind.invoice, assetId: asset.assetId }),
    (r) => r
  );
  assert(HEX_32.test(blindSend.txid), `send txid must be 64 hex chars, got: ${blindSend.txid}`);

  await step('blind send settles', () =>
    settle('blind send to settle', [receiver, sender], async () =>
      (await settledBalance(receiver, asset.assetId)) === BLIND_AMOUNT
    )
  );
  await step('balances after blind send', async () => {
    const sent = await settledBalance(sender, asset.assetId);
    assertEq(sent, ISSUED - BLIND_AMOUNT, 'sender settled balance');
    return { sender: sent, receiver: await settledBalance(receiver, asset.assetId) };
  }, (b) => b);

  await step('transfers are Settled', async () => {
    const out = (await sender.listTransfers(asset.assetId)).find((t) => t.txid === blindSend.txid);
    const inc = (await receiver.listTransfers(asset.assetId)).find((t) => t.recipientId === blind.recipientId);
    assert(out && inc, 'both wallets must list the transfer');
    assertEq(out.kind, 'Send', 'sender transfer kind');
    assertEq(inc.kind, 'ReceiveBlind', 'receiver transfer kind');
    assertEq(out.status, 'Settled', 'sender transfer status');
    assertEq(inc.status, 'Settled', 'receiver transfer status');
    return { sender: out.status, receiver: inc.status };
  }, (s) => s);

  // ── witness receive ────────────────────────────────────────────────────────
  const witness = await step(
    'receiver witnessReceive',
    () => receiver.witnessReceive({ assetId: asset.assetId, amount: WITNESS_AMOUNT }),
    (r) => r
  );
  const receiverWebRgb = webRgb(receiver);
  await step('getReceivedMint is served', async () => {
    assert(typeof receiver.getReceivedMint === 'function', 'the facade must expose getReceivedMint');
    const { methods } = await receiverWebRgb.getInfo();
    assert(methods.includes('getReceivedMint'), 'WebRGB getInfo().methods must list getReceivedMint');
    return methods.length;
  }, (n) => ({ methods: n }));
  await step('getReceivedMint before the send: no mint', async () => {
    const native = await receiver.getReceivedMint!(witness.recipientId, { refreshIncoming: true });
    assertEq(native, undefined, 'native getReceivedMint for an NIA receive');
    const offline = await receiver.getReceivedMint!(witness.recipientId);
    assertEq(offline, undefined, 'native getReceivedMint without a refresh');
    const viaWebRgb = await receiverWebRgb.getReceivedMint({ invoice: witness.invoice });
    assertEq(viaWebRgb, null, 'WebRGB getReceivedMint for an NIA receive');
    return { native: String(native), webrgb: String(viaWebRgb) };
  }, (r) => r);
  await step('getReceivedMint refuses a foreign invoice and serves one without an asset', async () => {
    const foreign = await rejectCode('a foreign invoice', () =>
      webRgb(sender).getReceivedMint({ invoice: witness.invoice })
    );
    assertEq(foreign, 'INVALID_PARAMS', 'an invoice the wallet did not create');
    // A first receive of an asset the wallet does not hold names no asset.
    const anyAsset = await receiverWebRgb.getReceivedMint({ invoice: blind.invoice });
    assertEq(anyAsset, null, 'the blind invoice names no asset and has no mint');
    return { foreign, anyAsset: String(anyAsset) };
  }, (r) => r);

  const witnessSend = await step(
    'onchainSend (witness)',
    () => sender.onchainSend({
      invoice: witness.invoice,
      assetId: asset.assetId,
      witnessData: { amountSat: WITNESS_SATS },
    }),
    (r) => r
  );
  assert(HEX_32.test(witnessSend.txid), 'witness send txid must be 64 hex chars');

  await step('witness send settles', () =>
    settle('witness send to settle', [receiver, sender], async () =>
      (await settledBalance(receiver, asset.assetId)) === BLIND_AMOUNT + WITNESS_AMOUNT
    )
  );
  await step('balances after witness send', async () => {
    const sent = await settledBalance(sender, asset.assetId);
    assertEq(sent, ISSUED - BLIND_AMOUNT - WITNESS_AMOUNT, 'sender settled balance');
    const inc = (await receiver.listTransfers(asset.assetId)).find((t) => t.recipientId === witness.recipientId);
    assert(inc, 'receiver must list the witness transfer');
    assertEq(inc.kind, 'ReceiveWitness', 'receiver witness transfer kind');
    return { sender: sent };
  }, (b) => b);
  await step('getReceivedMint after the send settles: still no mint', async () => {
    assertEq(await receiver.getReceivedMint!(witness.recipientId, { refreshIncoming: true }), undefined, 'native');
    assertEq(await receiverWebRgb.getReceivedMint({ invoice: witness.invoice }), null, 'WebRGB');
    return 'none';
  }, (r) => r);
}
