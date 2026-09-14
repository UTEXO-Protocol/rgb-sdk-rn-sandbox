/**
 * Scenario C — RGB assets (§7a.3).
 *
 * issueAssetNia → listAssets → getAssetBalance → blindReceive →
 * decodeRGBInvoice → listTransfers. The invoice must decode back to the same
 * assetId — the check that caught web's raw-wire `decodeRGBInvoice` (§6.0l),
 * and the reason this scenario runs on rn too rather than being assumed shared.
 */
import {
  expectFields,
  expectEach,
  expectNoWireKeys,
} from '@utexo/rgb-sdk-core/conformance';

import { assert, assertEq, type ScenarioContext } from '../harness';

const TRANSFER_STATUSES = [
  'WaitingCounterparty',
  'WaitingSafeHeight',
  'WaitingBroadcast',
  'WaitingConfirmations',
  'Settled',
  'Failed',
  'Initiated',
];
const TRANSFER_KINDS = [
  'Issuance',
  'ReceiveBlind',
  'ReceiveWitness',
  'Send',
  'Inflation',
  'Burn',
];
const NETWORKS = ['mainnet', 'testnet', 'testnet4', 'regtest', 'signet', 'utexo'];

const ISSUED_SUPPLY = 1000;

export async function scenarioC(ctx: ScenarioContext): Promise<void> {
  const { wallet, step } = ctx;

  const issued = await step(
    'issueAssetNia',
    () =>
      wallet.issueAssetNia({
        ticker: 'E2ET',
        name: 'E2E Test Asset',
        precision: 0,
        amounts: [ISSUED_SUPPLY],
      }),
    (a) => a
  );
  expectFields(issued, {
    assetId: { type: 'string', nonEmpty: true },
    ticker: { oneOf: ['E2ET'] },
    name: { oneOf: ['E2E Test Asset'] },
    precision: { oneOf: [0] },
    issuedSupply: { type: 'number', min: ISSUED_SUPPLY, max: ISSUED_SUPPLY },
    'balance.settled': { type: 'number' },
    'balance.future': { type: 'number' },
    'balance.spendable': { type: 'number' },
  });
  expectNoWireKeys(issued);
  const assetId = issued.assetId;
  ctx.state.assetId = assetId;

  const assets = await step(
    'listAssets',
    () => wallet.listAssets(),
    (a) => ({ nia: a.nia?.length ?? 0, cfa: a.cfa?.length ?? 0, ifa: a.ifa?.length ?? 0 })
  );
  assert(
    (assets.nia ?? []).some((a) => a.assetId === assetId),
    `issued asset ${assetId} must appear in listAssets.nia`
  );

  const balance = await step(
    'getAssetBalance',
    () => wallet.getAssetBalance(assetId),
    (b) => b
  );
  expectFields(balance, {
    settled: { type: 'number', optional: true },
    future: { type: 'number', optional: true },
    spendable: { type: 'number', optional: true },
  });
  // `future` is the projected TOTAL, not a pending delta: a fresh issuance
  // reports settled = future = spendable = issuedSupply (§6.0l).
  assertEq(balance.settled, ISSUED_SUPPLY, 'issued supply must be settled');

  const receive = await step(
    'blindReceive',
    () =>
      wallet.blindReceive({
        assetId,
        amount: 1,
        minConfirmations: 1,
        durationSeconds: 3600,
      }),
    (r) => r
  );
  expectFields(receive, {
    invoice: { type: 'string', nonEmpty: true },
    recipientId: { type: 'string', nonEmpty: true },
    batchTransferIdx: { type: 'number' },
  });
  expectNoWireKeys(receive);

  const decoded = await step(
    'decodeRGBInvoice',
    () => wallet.decodeRGBInvoice({ invoice: receive.invoice }),
    (d) => d
  );
  expectFields(decoded, {
    recipientId: { type: 'string', nonEmpty: true },
    assetId: { type: 'string', optional: true },
    network: { oneOf: NETWORKS },
    transportEndpoints: { type: 'array', nonEmpty: true },
  });
  assertEq(decoded.assetId, assetId, 'invoice must decode back to the same assetId');
  assertEq(decoded.recipientId, receive.recipientId, 'decoded recipientId');
  expectNoWireKeys(decoded);

  const transfers = await step(
    'listTransfers',
    () => wallet.listTransfers(assetId),
    (list) => ({ count: list.length, kinds: list.map((t) => t.kind) })
  );
  assert(transfers.length > 0, 'listTransfers must report the issuance');
  expectEach(transfers, {
    idx: { type: 'number' },
    createdAt: { type: 'number', min: 1 },
    updatedAt: { type: 'number', min: 1 },
    status: { oneOf: TRANSFER_STATUSES },
    kind: { oneOf: TRANSFER_KINDS },
  });
  for (const t of transfers) expectNoWireKeys(t);
  assert(
    transfers.some((t) => t.kind === 'Issuance'),
    'the issuance transfer must be listed'
  );
}
