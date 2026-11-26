/**
 * Scenario L5 — prepare, approve and submit as separate steps on RGB_L1.
 *
 * Runs on its own wallet, on the engine's `beginEnd` and `psbt` carriers:
 * a declined burn gives its inputs back, an approved burn reports the exact
 * fee of the transaction that reaches the chain, and repeating an end step
 * with the same signed PSBT returns the same result instead of a second
 * submission. Also covers the other begin/end pairs.
 */
import {
  CallbackRgbLibRnKeyProvider,
  RgbLibRn as RgbLibEngine,
  generateKeys,
} from '@utexo/rgb-sdk-rn';
import { UTEXOWallet } from '@utexo/rgb-sdk';

import { assert, assertEq, waitFor } from '../harness';
import {
  FEE_RATE,
  expectRejects,
  freshDir,
  fundWallet,
  bitcoinCliJson,
  createColorableUtxos,
  mine,
  settle,
  settledBalance,
  type RgbLibScenarioContext,
} from '../rgb-lib-harness';

const ISSUED = 5_000;
const INFLATED = 300;
const DECLINED_BURN = 700;
const BURNED = 1_200;
const SENT = 400;
const SENT_SATS = 20_000;

/** Equal by value; `assertEq` compares objects by reference. */
const assertSame = (actual: unknown, expected: unknown, label: string) =>
  assertEq(JSON.stringify(actual), JSON.stringify(expected), label);

export async function scenarioL5(ctx: RgbLibScenarioContext): Promise<void> {
  const { step } = ctx;
  const receiver = ctx.receiver.wallet;
  const { mnemonic } = await generateKeys('regtest');
  const engine = new RgbLibEngine(
    { network: 'regtest', storageDirPath: await freshDir('begin_end'), witnessVersion: 'taproot' },
    new CallbackRgbLibRnKeyProvider(async () => mnemonic),
  );
  const wallet = new UTEXOWallet({ engine });
  await wallet.init();
  await wallet.unlock(ctx.unlockParams);

  try {
    const flows = engine.beginEnd;
    const psbt = engine.psbt;
    assert(psbt, 'a wallet with a mnemonic must have the psbt carrier');
    assertEq(engine.capabilities.beginEndFlows, true, 'beginEndFlows');
    assertEq(engine.capabilities.psbtSigning, true, 'psbtSigning');

    await step('fund', () => fundWallet(wallet, 1));

    await step('createUtxosBegin and End', async () => {
      const unsigned = await flows.createUtxosBegin({ num: 8, size: 2_000, feeRate: FEE_RATE });
      const created = await flows.createUtxosEnd({ signedPsbt: await psbt.signPsbt(unsigned) });
      assert(created > 0, 'createUtxosEnd must report created UTXOs');
      await mine(1);
      await waitFor('colorable UTXOs', async () =>
        (await wallet.listUnspents()).filter((u) => u.utxo.colorable).length >= created
      );
      return { created };
    }, (r) => r);

    const asset = await step('issueAssetIfa', () => wallet.issueAssetIfa({
      ticker: 'L5IFA',
      name: 'L5 Begin End',
      precision: 0,
      amounts: [ISSUED],
      inflationAmounts: [INFLATED],
      rejectListUrl: null,
    }), (a) => ({ assetId: a.assetId }));
    const assetId = asset.assetId;
    const burnParams = (amount: number) => ({
      assetId,
      amount: String(amount),
      burnRecipient: 'ab'.repeat(32),
      feeRate: FEE_RATE,
      minConfirmations: 1,
    });

    // ── declined ───────────────────────────────────────────────────────────
    await step('a declined burn is failed and cannot be submitted', async () => {
      const begun = await flows.burnBegin(burnParams(DECLINED_BURN));
      const signedPsbt = await psbt.signPsbt(begun.psbt);
      assertEq(await wallet.failTransfers({ batchTransferIdx: begun.batchTransferIdx }), true, 'failTransfers');
      const message = await expectRejects('ending a declined burn', () => flows.burnEnd({ signedPsbt }));
      assertEq(await settledBalance(wallet, assetId), ISSUED, 'balance after a declined burn');
      return { batch: begun.batchTransferIdx, message };
    }, (r) => r);

    // ── approved ───────────────────────────────────────────────────────────
    const begun = await step('burnBegin shows the transaction', async () => {
      const value = await flows.burnBegin(burnParams(BURNED));
      assert(/^[0-9a-f]{64}$/.test(value.txid), 'txid must be 64 hex chars');
      assert(value.fee > 0 && value.vbytes > 0, 'fee and size must be positive');
      assertSame(await psbt.estimateFee(value.psbt), {
        fee: value.fee,
        vbytes: value.vbytes,
        feeRate: value.feeRate,
      }, 'estimateFee of the prepared PSBT');
      return value;
    }, ({ txid, fee, vbytes, feeRate, batchTransferIdx }) => ({ txid, fee, vbytes, feeRate, batchTransferIdx }));

    const signedPsbt = await step('signPsbt keeps the fee', async () => {
      const signed = await psbt.signPsbt(begun.psbt);
      assertEq((await psbt.estimateFee(signed)).fee, begun.fee, 'fee of the signed PSBT');
      return signed;
    }, (s) => ({ bytes: s.length }));

    const ended = await step('burnEnd submits', () => flows.burnEnd({ signedPsbt }), (r) => r);
    assertSame(ended, { txid: begun.txid, batchTransferIdx: begun.batchTransferIdx }, 'burnEnd result');

    await step('a repeated burnEnd returns the same result', async () => {
      const again = await flows.burnEnd({ signedPsbt });
      assertSame(again, ended, 'repeated burnEnd');
      const listed = (await wallet.listTransfers(assetId)).filter((t) => t.txid === begun.txid);
      assertEq(listed.length, 1, 'transfers with this txid');
      return { status: listed[0]?.status };
    }, (r) => r);

    await step('the chain has the exact fee', async () => {
      // Read from bitcoind, not the indexer: the stack's indexer is Electrum,
      // which has no REST API. burnEnd broadcast it, nothing mined it yet.
      const entry = await waitFor('burn in the mempool', () =>
        bitcoinCliJson<{ fees: { base: number }; weight: number }>(`getmempoolentry ${begun.txid}`).catch(() => null));
      const fee = Math.round(entry.fees.base * 1e8);
      assertEq(fee, begun.fee, 'fee on chain');
      assertEq(Math.ceil(entry.weight / 4), begun.vbytes, 'size on chain');
      return { fee, weight: entry.weight, vbytes: begun.vbytes };
    }, (r) => r);

    await step('burn settles', () =>
      settle('burn to settle', [wallet], async () =>
        (await settledBalance(wallet, assetId)) === ISSUED - BURNED
      )
    );

    await step('burnEnd after settlement returns the same result', async () => {
      assertSame(await flows.burnEnd({ signedPsbt }), ended, 'burnEnd after settlement');
      const burn = (await wallet.listTransfers(assetId)).find((t) => t.txid === begun.txid);
      assertEq(burn?.kind, 'Burn', 'transfer kind');
      assertEq(burn?.status, 'Settled', 'transfer status');
      return { kind: burn?.kind, status: burn?.status };
    }, (r) => r);

    await step('the burn consignment can be read', async () => {
      const consignment = await wallet.getConsignment(assetId, begun.txid);
      assert(consignment.length > 0, 'consignment must be non-empty');
      return { bytes: consignment.length };
    }, (r) => r);

    // ── the other pairs ────────────────────────────────────────────────────
    await step('inflateBegin and End, repeated', async () => {
      const unsigned = await flows.inflateBegin({ assetId, inflationAmounts: [INFLATED], feeRate: FEE_RATE });
      const signed = await psbt.signPsbt(unsigned);
      const first = await flows.inflateEnd({ signedPsbt: signed });
      assertSame(await flows.inflateEnd({ signedPsbt: signed }), first, 'repeated inflateEnd');
      await settle('inflation to settle', [wallet], async () =>
        (await settledBalance(wallet, assetId)) === ISSUED - BURNED + INFLATED
      );
      return first;
    }, (r) => r);

    await step('receiver is ready', async () => {
      await fundWallet(receiver, 0.1);
      try {
        return { created: await createColorableUtxos(receiver, 3) };
      } catch (error) {
        // rgb-lib refuses new UTXOs while enough free ones exist: ready as is.
        if (error instanceof Error && error.message.includes('AllocationsAlreadyAvailable')) return { created: 0 };
        throw error;
      }
    }, (r) => r);

    await step('onchainSendBegin and End, repeated', async () => {
      const receive = await receiver.blindReceive({ amount: SENT });
      const unsigned = await flows.onchainSendBegin({ invoice: receive.invoice, assetId, feeRate: FEE_RATE });
      const signed = await psbt.signPsbt(unsigned);
      const first = await flows.onchainSendEnd({ signedPsbt: signed });
      const status = (await wallet.listTransfers(assetId)).find((t) => t.txid === first.txid)?.status;
      assertSame(await flows.onchainSendEnd({ signedPsbt: signed }), first, `repeated onchainSendEnd (status ${status})`);
      await settle('send to settle', [receiver, wallet], async () =>
        (await settledBalance(receiver, assetId)) === SENT
      );
      assertSame(await flows.onchainSendEnd({ signedPsbt: signed }), first, 'onchainSendEnd after settlement');
      return { ...first, statusAfterEnd: status };
    }, (r) => r);

    await step('sendBtcBegin and End', async () => {
      const address = await receiver.getAddress();
      const unsigned = await flows.sendBtcBegin({ address, amount: SENT_SATS, feeRate: FEE_RATE });
      const { fee } = await psbt.estimateFee(unsigned);
      const txid = await flows.sendBtcEnd({ signedPsbt: await psbt.signPsbt(unsigned) });
      assert(/^[0-9a-f]{64}$/.test(txid), 'sendBtcEnd must return a txid');
      await mine(1);
      return { txid, fee };
    }, (r) => r);
  } finally {
    await wallet.dispose().catch(() => undefined);
  }
}
