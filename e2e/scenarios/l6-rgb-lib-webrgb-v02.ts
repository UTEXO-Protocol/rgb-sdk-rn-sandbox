/**
 * Scenario L6 — WebRGB 0.2 on the real RGB_L1 engine, and the mainnet
 * schema rule.
 *
 * A WebRGB session over a wallet of its own: `getInfo` lists the 0.2 wallet
 * methods and `on`/`off`, `createUtxos` rounds a fractional fee rate up,
 * `cancelReceive` fails a waiting invoice only after the prompt, and
 * `signPsbt` signs a bitcoin-only PSBT (which then broadcasts) but refuses a
 * PSBT that spends an RGB allocation before any prompt. A second session over
 * the receiver sees `transferReceived` and `transferSettled` for an incoming
 * send. Last, a mainnet wallet opens offline without `allowRecklessSchemas`
 * (rgb-lib's CannotUseSchemaOnMainnet otherwise) and refuses IFA, and with
 * the flag supports every schema.
 */
import {
  CallbackRgbLibRnKeyProvider,
  RgbLibRn as RgbLibEngine,
  generateKeys,
} from '@utexo/rgb-sdk-rn';
import { UTEXOWallet } from '@utexo/rgb-sdk';
import { BurnOperations, WEBRGB_WALLET_METHODS, WebRgbProvider, type WebRgbApproval } from '@utexo/rgb-sdk/webrgb';
import type { RgbTransfer } from '@utexo/webrgb';

import { assert, assertEq, waitFor } from '../harness';
import {
  FEE_RATE,
  freshDir,
  fundWallet,
  mine,
  settle,
  settledBalance,
  type RgbLibRn,
  type RgbLibScenarioContext,
} from '../rgb-lib-harness';

const ISSUED = 2_000;
const SENT = 250;
const SENT_SATS = 15_000;

/** A session that records every prompt and answers with `answer()`. */
function session(wallet: RgbLibRn, answer: (request: WebRgbApproval) => boolean = () => true) {
  const prompts: WebRgbApproval[] = [];
  const provider = new WebRgbProvider(wallet, {
    origin: 'https://e2e.example',
    sessionApproved: true,
    eventPollMs: 500,
    confirm: async (request) => {
      prompts.push(request);
      return answer(request);
    },
    burn: { operations: new BurnOperations(wallet, { readAll: async () => [], write: async () => undefined }) },
  });
  return { provider, prompts };
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

async function openOffline(network: 'mainnet', allowRecklessSchemas: boolean) {
  const { mnemonic } = await generateKeys(network);
  const wallet = new UTEXOWallet({
    engine: new RgbLibEngine(
      { network, storageDirPath: await freshDir(`mainnet_${allowRecklessSchemas}`), witnessVersion: 'taproot', allowRecklessSchemas },
      new CallbackRgbLibRnKeyProvider(async () => mnemonic),
    ),
  });
  await wallet.init();
  return wallet;
}

export async function scenarioL6(ctx: RgbLibScenarioContext): Promise<void> {
  const { step } = ctx;
  const receiver = ctx.receiver.wallet;
  const { mnemonic } = await generateKeys('regtest');
  const engine = new RgbLibEngine(
    { network: 'regtest', storageDirPath: await freshDir('webrgb_v02'), witnessVersion: 'taproot' },
    new CallbackRgbLibRnKeyProvider(async () => mnemonic),
  );
  const wallet = new UTEXOWallet({ engine });
  await wallet.init();
  await wallet.unlock(ctx.unlockParams);
  let decline = false;
  const { provider, prompts } = session(wallet, () => !decline);
  const watcher = session(receiver);

  try {
    await step('fund', () => fundWallet(wallet, 1));
    await provider.enable();
    await watcher.provider.enable();

    await step('getInfo lists the 0.2 methods and events', async () => {
      const { methods } = await provider.getInfo();
      for (const method of [...WEBRGB_WALLET_METHODS, 'on', 'off'])
        assert(methods.includes(method as never), `getInfo must list ${method}`);
      return { methods };
    }, (r) => r);

    await step('createUtxos rounds a fractional fee rate up', async () => {
      const result = await provider.createUtxos({ num: 4, size: 2_000, feeRate: 1.2 });
      assert(result.created > 0, 'createUtxos must create UTXOs');
      const prompt = prompts.at(-1)!;
      assertEq(prompt.method, 'createUtxos', 'prompt method');
      assertEq(prompt.params.feeRate, 2, 'fee rate shown in the prompt');
      await mine(1);
      await waitFor('colorable UTXOs', async () =>
        (await provider.getBtcBalance()).colored.settled > 0);
      return result;
    }, (r) => r);

    const assetId = await step('issueAssetNia', async () =>
      (await wallet.issueAssetNia({ ticker: 'L6NIA', name: 'L6 WebRGB', amounts: [ISSUED], precision: 0 })).assetId,
    (id) => ({ assetId: id }));

    await step('getAssetMetadata', async () => {
      const metadata = await provider.getAssetMetadata(assetId);
      assertEq(metadata.ticker, 'L6NIA', 'ticker');
      assertEq(metadata.precision, 0, 'precision');
      return metadata;
    }, (r) => r);

    await step('cancelReceive: declined, then cancelled, then nothing to cancel', async () => {
      const invoice = await provider.blindReceive({ assetId, amount: 10 });
      assert(invoice.recipientId, 'blindReceive must return a recipientId');
      const recipientId = invoice.recipientId!;
      decline = true;
      assertEq(await rejectCode('a declined cancel', () => provider.cancelReceive(recipientId)), 'USER_REJECTED', 'declined code');
      decline = false;
      const waiting = (await wallet.listTransfers(assetId)).find((t) => t.recipientId === recipientId);
      assertEq(waiting?.status, 'WaitingCounterparty', 'status after a declined cancel');
      const before = prompts.length;
      assertEq((await provider.cancelReceive(recipientId)).cancelled, true, 'cancelled');
      assertEq(prompts.at(-1)?.method, 'cancelReceive', 'cancel prompt');
      assertEq(prompts.at(-1)?.params.recipientId, recipientId, 'prompt recipientId');
      const failed = (await wallet.listTransfers(assetId)).find((t) => t.recipientId === recipientId);
      assertEq(failed?.status, 'Failed', 'status after cancel');
      assertEq((await provider.cancelReceive(recipientId)).cancelled, false, 'second cancel');
      assertEq(prompts.length, before + 1, 'the second cancel does not prompt');
      assertEq(await rejectCode('a bad recipientId', () => provider.cancelReceive('')), 'INVALID_PARAMS', 'empty recipientId');
      return { recipientId };
    }, (r) => r);

    await step('signPsbt signs a bitcoin-only PSBT that then broadcasts', async () => {
      const address = await receiver.getAddress();
      const unsigned = await engine.beginEnd.sendBtcBegin({ address, amount: SENT_SATS, feeRate: FEE_RATE });
      const signed = await provider.signPsbt(unsigned);
      assert(signed.signedInputs > 0, 'signPsbt must sign the wallet inputs');
      const prompt = prompts.at(-1)!;
      assertEq(prompt.method, 'signPsbt', 'prompt method');
      const outputs = prompt.params.outputs as { address: string | null; amount: number }[];
      assert(outputs.some((o) => o.address === address && o.amount === SENT_SATS), 'prompt must show the payment');
      assert(typeof prompt.params.fee === 'number' && prompt.params.fee > 0, 'prompt must show the fee');
      const txid = await engine.beginEnd.sendBtcEnd({ signedPsbt: signed.psbt });
      assert(/^[0-9a-f]{64}$/.test(txid), 'sendBtcEnd must accept the signed PSBT');
      await mine(1);
      return { txid, signedInputs: signed.signedInputs, fee: prompt.params.fee };
    }, (r) => r);

    await step('signPsbt refuses a PSBT that spends an RGB allocation, before any prompt', async () => {
      const invoice = await receiver.blindReceive({ amount: SENT, minConfirmations: 1 });
      const known = new Set((await wallet.listTransfers(assetId)).map((t) => t.batchTransferIdx));
      const unsigned = await engine.beginEnd.onchainSendBegin({ invoice: invoice.invoice, assetId, feeRate: FEE_RATE });
      const before = prompts.length;
      try {
        assertEq(await rejectCode('a colored PSBT', () => provider.signPsbt(unsigned)), 'UNSAFE_PSBT', 'code');
        assertEq(prompts.length, before, 'no prompt for an unsafe PSBT');
        assertEq(await rejectCode('a malformed PSBT', () => provider.signPsbt('not a psbt')), 'INVALID_PARAMS', 'malformed');
      } finally {
        // Give the begun send's allocation back: the events step spends it.
        const begun = (await wallet.listTransfers(assetId)).filter((t) => !known.has(t.batchTransferIdx));
        assert(begun.length > 0, 'onchainSendBegin must record its send');
        for (const batchTransferIdx of new Set(begun.map((t) => t.batchTransferIdx)))
          assertEq(await wallet.failTransfers({ batchTransferIdx: batchTransferIdx! }), true, 'failTransfers of the begun send');
      }
      return { invoice: invoice.recipientId };
    }, (r) => r);

    await step('events: transferReceived and transferSettled for an incoming send', async () => {
      const received: RgbTransfer[] = [];
      const settled: RgbTransfer[] = [];
      const onReceived = (t: RgbTransfer) => received.push(t);
      const onSettled = (t: RgbTransfer) => settled.push(t);
      watcher.provider.on('transferReceived', onReceived);
      watcher.provider.on('transferSettled', onSettled);
      try {
        const invoice = await watcher.provider.blindReceive({ assetId: undefined, amount: SENT });
        const recipientId = invoice.recipientId!;
        // The watcher's first poll records the waiting receive before the send.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await wallet.onchainSend({ invoice: invoice.invoice, assetId });
        await settle('the incoming send', [wallet, receiver], async () =>
          settled.some((t) => t.recipientId === recipientId));
        assert(received.some((t) => t.recipientId === recipientId), 'transferReceived for the receive');
        assertEq(await settledBalance(receiver, assetId), SENT, 'receiver balance');
        return { recipientId, received: received.length, settled: settled.length };
      } finally {
        watcher.provider.off('transferReceived', onReceived);
        watcher.provider.off('transferSettled', onSettled);
      }
    }, (r) => r);

    await step('mainnet without allowRecklessSchemas opens and refuses IFA', async () => {
      const mainnet = await openOffline('mainnet', false);
      try {
        const caps = await mainnet.getBfaCapabilities();
        assertEq(caps.burn, false, 'burn capability');
        const message = await rejectCode('IFA issuance on mainnet', () => mainnet.issueAssetIfa({
          ticker: 'NOPE', name: 'Refused', precision: 0, amounts: [1], inflationAmounts: [], rejectListUrl: null,
        }));
        assertEq(message, 'UNSUPPORTED_CAPABILITY', 'IFA refusal code');
        return { caps };
      } finally {
        await mainnet.dispose().catch(() => undefined);
      }
    }, (r) => r);

    await step('mainnet with allowRecklessSchemas opens with every schema', async () => {
      const mainnet = await openOffline('mainnet', true);
      try {
        const caps = await mainnet.getBfaCapabilities();
        assertEq(caps.burn, true, 'burn capability');
        return { caps };
      } finally {
        await mainnet.dispose().catch(() => undefined);
      }
    }, (r) => r);
  } finally {
    provider.revoke();
    watcher.provider.revoke();
    await wallet.dispose().catch(() => undefined);
  }
}
