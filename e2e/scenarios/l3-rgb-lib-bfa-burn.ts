/**
 * Scenario L3 — the BFA send (burn) path on regtest.
 *
 * A real BFA asset is minted by the bridge from an EVM deposit, which a local
 * regtest stack does not run. rgb-lib burns IFA and BFA through the same code
 * (`SCHEMAS_SUPPORTING_BURN`), so this scenario burns an IFA asset along the
 * exact route a BFA send takes in the wallet:
 *
 *   payout address → burn destination (route eip155:31337) → 32-byte hash →
 *   BurnOperations journal → wallet.burn → consignment the bridge would read.
 *
 * It also checks that NIA, which has no burn right, is refused.
 */
import { BurnOperations, type BurnOperationRecord } from '@utexo/rgb-sdk-rn';
import { burnDestinationHash, createBurnDestination } from '@utexo/rgb-sdk-rn/webrgb';
import { HEX_32 } from '@utexo/rgb-sdk-core/conformance';

import { assert, assertEq } from '../harness';
import {
  FEE_RATE,
  expectRejects,
  settle,
  settledBalance,
  type RgbLibScenarioContext,
} from '../rgb-lib-harness';

const ISSUED = 5_000;
const BURN_AMOUNT = 1_200;
/** The demo's regtest bridge route (utils/wallet/profiles.ts). */
const ROUTES = [{ chainId: 'eip155:31337', dstEid: 0 }] as const;
const PAYOUT = { chainId: 'eip155:31337', address: '0x00000000000000000000000000000000000e2e01' };

function memoryStore() {
  const records = new Map<string, BurnOperationRecord>();
  return {
    records,
    store: {
      readAll: async () => [...records.values()],
      write: async (record: BurnOperationRecord) => {
        records.set(record.id, record);
      },
    },
  };
}

export async function scenarioL3(ctx: RgbLibScenarioContext): Promise<void> {
  const { step } = ctx;
  const sender = ctx.sender.wallet;

  const ifa = await step(
    'issueAssetIfa',
    () => sender.issueAssetIfa({
      ticker: 'L3IFA',
      name: 'L3 Burnable',
      precision: 0,
      amounts: [ISSUED],
      inflationAmounts: [1_000],
      rejectListUrl: null,
    }),
    (a) => ({ assetId: a.assetId })
  );
  ctx.state.ifaAssetId = ifa.assetId;

  const niaAssetId = ctx.state.niaAssetId as string | undefined;
  if (niaAssetId) {
    await step('burn NIA is refused', () =>
      expectRejects('burning NIA', () =>
        sender.burn({ assetId: niaAssetId, amount: '1', feeRate: FEE_RATE, minConfirmations: 1 })
      ), (message) => ({ message }));
  }

  await step('invalid burn params are refused', () =>
    expectRejects('burning zero', () =>
      sender.burn({ assetId: ifa.assetId, amount: '0', feeRate: FEE_RATE, minConfirmations: 1 })
    ), (message) => ({ message }));

  const destination = createBurnDestination(PAYOUT, ROUTES);
  const burnRecipient = burnDestinationHash(destination).slice(2);
  assert(/^[0-9a-f]{64}$/.test(burnRecipient), 'burn recipient must be a 32-byte hash');

  const { records, store } = memoryStore();
  const operations = new BurnOperations(sender, store);
  const record = await step(
    'BurnOperations.execute',
    () => operations.execute(
      { assetId: ifa.assetId, amount: String(BURN_AMOUNT), burnRecipient, feeRate: FEE_RATE, minConfirmations: 1 },
      { origin: 'e2e:L3', network: 'regtest', payout: PAYOUT, burnDestination: destination },
      () => undefined
    ),
    (r) => ({ id: r.id, state: r.state, result: r.result })
  );
  assertEq(record.state, 'complete', 'journal state');
  const txid = record.result?.txid ?? '';
  assert(HEX_32.test(txid), `burn txid must be 64 hex chars, got: ${txid}`);
  assertEq(records.get(record.id)?.state, 'complete', 'stored journal state');

  await step('burn settles', () =>
    settle('burn to settle', [sender], async () =>
      (await settledBalance(sender, ifa.assetId)) === ISSUED - BURN_AMOUNT
    )
  );

  await step('burn transfer is listed', async () => {
    const burn = (await sender.listTransfers(ifa.assetId)).find((t) => t.txid === txid);
    assert(burn, 'listTransfers must include the burn');
    assertEq(burn.kind, 'Burn', 'burn transfer kind');
    assertEq(burn.status, 'Settled', 'burn transfer status');
    return { kind: burn.kind, status: burn.status };
  }, (b) => b);

  // What the bridge consumes to release funds on the payout chain.
  await step('getConsignment', async () => {
    const consignment = await sender.getConsignment(ifa.assetId, txid);
    assert(typeof consignment === 'string' && consignment.length > 0, 'consignment must be non-empty');
    const path = await sender.getConsignmentPath(ifa.assetId, txid);
    assert(path.startsWith('/'), `consignment path must be absolute, got: ${path}`);
    return { bytes: consignment.length, path };
  }, (c) => c);

  await step('a second burn is not blocked by the first', async () => {
    const next = await operations.execute(
      { assetId: ifa.assetId, amount: '1', burnRecipient, feeRate: FEE_RATE, minConfirmations: 1 },
      { origin: 'e2e:L3', network: 'regtest', payout: PAYOUT, burnDestination: destination },
      () => undefined
    );
    assertEq(next.state, 'complete', 'second journal state');
    await settle('second burn to settle', [sender], async () =>
      (await settledBalance(sender, ifa.assetId)) === ISSUED - BURN_AMOUNT - 1
    );
    return { txid: next.result?.txid };
  }, (r) => r);
}
