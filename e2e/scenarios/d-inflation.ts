/**
 * Scenario D — IFA + inflation (§7a.3). **The scenario that closes step 1b.**
 *
 * issueAssetIfa → inflate → mine → getAssetBalance. This is the only proof that
 * `rlnInflate` *works* rather than merely compiles: §6.0c wired it and §6.0g
 * verified it compiles on both Android and iOS, but nothing has ever executed
 * it. web cannot stand in — it reaches inflation through the `beginEnd`
 * carrier, which rn does not have (§2.6, §2.7a).
 *
 * Balance must rise by **exactly** the inflation amount; "it didn't throw" is
 * precisely the weak assertion this suite exists to replace.
 */
import { expectFields, expectNoWireKeys, HEX_32 } from '@utexo/rgb-sdk-core/conformance';

import { mine } from '@/utils/bitcoin-node';

import { assert, assertEq, waitFor, type ScenarioContext } from '../harness';

const ISSUED_SUPPLY = 500;
const INFLATION_RIGHTS = 500;
const INFLATE_BY = 250;

export async function scenarioD(ctx: ScenarioContext): Promise<void> {
  const { wallet, step } = ctx;

  const issued = await step(
    'issueAssetIfa',
    () =>
      wallet.issueAssetIfa({
        ticker: 'E2EI',
        name: 'E2E Inflatable',
        precision: 0,
        amounts: [ISSUED_SUPPLY],
        inflationAmounts: [INFLATION_RIGHTS],
        rejectListUrl: null,
      }),
    (a) => a
  );

  // IFA reports supply as initial/max/known-circulating — there is no
  // `issuedSupply`, unlike NIA and CFA.
  expectFields(issued, {
    assetId: { type: 'string', nonEmpty: true },
    ticker: { oneOf: ['E2EI'] },
    name: { oneOf: ['E2E Inflatable'] },
    precision: { oneOf: [0] },
    initialSupply: { type: 'number', min: ISSUED_SUPPLY, max: ISSUED_SUPPLY },
    maxSupply: {
      type: 'number',
      min: ISSUED_SUPPLY + INFLATION_RIGHTS,
      max: ISSUED_SUPPLY + INFLATION_RIGHTS,
    },
    knownCirculatingSupply: { type: 'number', min: ISSUED_SUPPLY, max: ISSUED_SUPPLY },
    'balance.settled': { type: 'number' },
    'balance.future': { type: 'number' },
    'balance.spendable': { type: 'number' },
  });
  expectNoWireKeys(issued);
  const assetId = issued.assetId;
  ctx.state.ifaAssetId = assetId;

  await step(
    'confirm issuance',
    async () => {
      await mine(1);
      await wallet.syncWallet();
      await wallet.refreshWallet();
      return true;
    },
    () => ({ mined: 1 })
  );

  const before = await step(
    'getAssetBalance (before inflate)',
    () =>
      waitFor(
        `IFA balance to settle at ${ISSUED_SUPPLY}`,
        async () => {
          const bal = await wallet.getAssetBalance(assetId);
          return (bal.spendable ?? 0) >= ISSUED_SUPPLY ? bal : null;
        },
        {
          attempts: 30,
          delayMs: 2000,
          onAttempt: async () => {
            await mine(1);
            await wallet.syncWallet();
            await wallet.refreshWallet();
          },
        }
      ),
    (b) => b
  );
  assertEq(before.settled, ISSUED_SUPPLY, 'IFA issued supply must be settled');

  const inflated = await step(
    'inflate',
    () =>
      wallet.inflate({
        assetId,
        inflationAmounts: [INFLATE_BY],
        feeRate: 7,
        minConfirmations: 1,
      }),
    (r) => r
  );
  expectFields(inflated, { txid: { type: 'string', pattern: HEX_32 } });
  expectNoWireKeys(inflated);
  // No `batchTransferIdx`: inflation is not a batch transfer, and the rn wallet
  // deliberately invents nothing the uniffi response does not carry.
  assert(
    !('batchTransferIdx' in inflated),
    'inflate must not invent a batchTransferIdx'
  );

  const after = await step(
    'getAssetBalance (after inflate)',
    () =>
      waitFor(
        `IFA balance to reach ${ISSUED_SUPPLY + INFLATE_BY}`,
        async () => {
          const bal = await wallet.getAssetBalance(assetId);
          return (bal.settled ?? 0) >= ISSUED_SUPPLY + INFLATE_BY ? bal : null;
        },
        {
          attempts: 45,
          delayMs: 2000,
          onAttempt: async () => {
            await mine(1);
            await wallet.syncWallet();
            await wallet.refreshWallet();
          },
        }
      ),
    (b) => b
  );

  // The actual claim: balance rose by exactly the inflation amount.
  assertEq(
    (after.settled ?? 0) - (before.settled ?? 0),
    INFLATE_BY,
    'settled balance must rise by exactly the inflation amount'
  );

  const transfers = await step(
    'listTransfers (inflation)',
    () => wallet.listTransfers(assetId),
    (list) => ({ count: list.length, kinds: list.map((t) => t.kind) })
  );
  assert(
    transfers.some((t) => t.txid === inflated.txid),
    `the inflation tx ${inflated.txid} must appear in listTransfers`
  );

  // The same asset, reached through the other call: both must agree.
  const listed = await step(
    'listAssets (ifa)',
    async () => (await wallet.listAssets()).ifa ?? [],
    (list) => ({ count: list.length })
  );
  const entry = listed.find((a) => a.assetId === assetId);
  assert(entry !== undefined, `the IFA asset must appear in listAssets.ifa`);
  assertEq(entry.ticker, issued.ticker, 'listAssets ticker vs issueAssetIfa');
  assertEq(entry.maxSupply, issued.maxSupply, 'listAssets maxSupply vs issueAssetIfa');
  expectNoWireKeys(entry);
}
