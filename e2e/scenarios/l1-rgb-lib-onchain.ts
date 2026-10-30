/**
 * Scenario L1 — RGB_L1 wallet, BTC and on-chain send.
 *
 * Both rgb-lib wallets are funded here and given colorable UTXOs; L2–L4 depend
 * on that. The send asserts value, not shape: the receiver's balance must grow
 * by exactly the amount sent, and the sender must list the transaction.
 */
import { expectFields, expectNoWireKeys, HEX_32 } from '@utexo/rgb-sdk-core/conformance';

import { assert, assertEq, waitFor } from '../harness';
import {
  FEE_RATE,
  createColorableUtxos,
  fundWallet,
  mine,
  type RgbLibScenarioContext,
} from '../rgb-lib-harness';

const SEND_SATS = 25_000;
const UTXO_COUNT = 6;

export async function scenarioL1(ctx: RgbLibScenarioContext): Promise<void> {
  const { step } = ctx;
  const sender = ctx.sender.wallet;
  const receiver = ctx.receiver.wallet;

  await step('protocol and network', async () => {
    assertEq(sender.protocol, 'RGB_L1', 'protocol');
    assertEq(sender.getNetwork(), 'regtest', 'getNetwork');
    const identity = await sender.getWalletIdentity();
    assertEq(identity.protocol, 'RGB_L1', 'identity.protocol');
    assertEq(identity.network, 'regtest', 'identity.network');
    const other = await receiver.getWalletIdentity();
    assert(identity.id !== other.id, 'two fresh wallets must have different identities');
    return identity;
  }, (identity) => identity);

  await step('getBfaCapabilities', async () => {
    const caps = await sender.getBfaCapabilities();
    expectFields(caps, { burn: { oneOf: [true] }, consignment: { oneOf: [true] }, bfa: { oneOf: [true] } });
    return caps;
  }, (caps) => caps);

  const address = await step('getAddress', () => sender.getAddress(), (a) => ({ address: a }));
  assert(address.startsWith('bcrt1'), `regtest bech32 address expected, got: ${address}`);

  await step('fund sender', () => fundWallet(sender, 1), (txid) => ({ txid }));
  await step('fund receiver', () => fundWallet(receiver, 0.5), (txid) => ({ txid }));

  const balance = await step('getBtcBalance', () => sender.getBtcBalance(), (b) => b);
  expectFields(balance, {
    'vanilla.settled': { type: 'number', min: 1 },
    'vanilla.spendable': { type: 'number', min: 1 },
    'colored.settled': { type: 'number', min: 0 },
  });
  expectNoWireKeys(balance);

  await step('createUtxos (sender)', () => createColorableUtxos(sender, UTXO_COUNT), (n) => ({ created: n }));
  await step('createUtxos (receiver)', () => createColorableUtxos(receiver, UTXO_COUNT), (n) => ({ created: n }));

  const unspents = await step('listUnspents', () => sender.listUnspents(), (u) => ({ count: u.length }));
  for (const unspent of unspents) {
    assert(HEX_32.test(unspent.utxo.outpoint.txid), 'outpoint.txid must be 64 hex chars');
    assert(Number.isInteger(unspent.utxo.outpoint.vout), 'outpoint.vout must be an integer');
  }
  assert(unspents.some((u) => u.utxo.colorable), 'sender must hold colorable UTXOs');

  // sendBtc spends vanilla funds to another wallet; the receiver must see exactly SEND_SATS more.
  const before = (await receiver.getBtcBalance()).vanilla.settled;
  const receiverAddress = await receiver.getAddress();
  const txid = await step(
    'sendBtc',
    () => sender.sendBtc({ address: receiverAddress, amount: SEND_SATS, feeRate: FEE_RATE }),
    (id) => ({ txid: id })
  );
  assert(HEX_32.test(txid), `sendBtc txid must be 64 hex chars, got: ${txid}`);
  await mine(1);

  await step('receiver balance after sendBtc', () =>
    waitFor('receiver vanilla balance to grow', async () => {
      const after = (await receiver.getBtcBalance()).vanilla.settled;
      return after === before + SEND_SATS ? after : null;
    }), (after) => ({ before, after }));

  await step('listTransactions has the send', async () => {
    const txs = await sender.listTransactions();
    const sent = txs.find((tx) => tx.txid === txid);
    assert(sent, `listTransactions must include ${txid}`);
    assert(sent.sent > sent.received, 'the sender must have spent more than it received back');
    return sent;
  }, (tx) => tx);
}
