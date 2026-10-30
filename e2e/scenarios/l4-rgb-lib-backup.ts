/**
 * Scenario L4 — RGB_L1 backup survives device loss.
 *
 * The sender, holding BTC and the L2/L3 assets, writes an encrypted backup.
 * The wallet is then closed and its directory deleted (the "lost device").
 * `restoreFromBackup` rebuilds it into a new, empty directory, and the
 * restored wallet must show the same assets and balances and still be able to
 * send. A wrong password must be refused.
 *
 * Replaces `ctx.sender` with the restored wallet; teardown disposes it.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { restoreFromBackup } from '@utexo/rgb-sdk-rn';
import { HEX_32 } from '@utexo/rgb-sdk-core/conformance';

import { assert, assertEq } from '../harness';
import {
  bootRgbLibWallet,
  expectRejects,
  freshDir,
  settle,
  settledBalance,
  type RgbLibScenarioContext,
  type RgbLibWallet,
} from '../rgb-lib-harness';

const PASSWORD = 'e2e-backup-password';
const SEND_AFTER_RESTORE = 10;

async function snapshot(wallet: RgbLibWallet) {
  const assets = await wallet.listAssets();
  const ids = [...assets.nia, ...assets.ifa, ...assets.cfa, ...assets.uda, ...assets.bfa]
    .map((a) => a.assetId)
    .sort();
  const balances: Record<string, number> = {};
  for (const id of ids) balances[id] = await settledBalance(wallet, id);
  const btc = await wallet.getBtcBalance();
  return { ids, balances, btc: btc.vanilla.settled + btc.colored.settled };
}

export async function scenarioL4(ctx: RgbLibScenarioContext): Promise<void> {
  const { step } = ctx;
  const original = ctx.sender;
  const niaAssetId = ctx.state.niaAssetId as string | undefined;

  const before = await step('snapshot before backup', async () => {
    await original.wallet.refreshWallet();
    return snapshot(original.wallet);
  }, (s) => s);
  assert(before.ids.length > 0, 'the wallet must hold assets before backup (run L2/L3 first)');

  const backupDir = await freshDir('backup');
  const backupFilePath = `${backupDir}/wallet.rgb-backup`;
  await step('createBackup', () =>
    original.wallet.createBackup({ backupPath: backupFilePath, password: PASSWORD }),
  (r) => r);
  const info = await FileSystem.getInfoAsync(`file://${backupFilePath}`);
  assert(info.exists && (info.size ?? 0) > 0, 'the backup file must exist and be non-empty');

  await step('lose the device', async () => {
    await original.wallet.dispose();
    assert(original.wallet.isDisposed(), 'the original wallet must be disposed');
    await FileSystem.deleteAsync(`file://${original.storageDirPath}`, { idempotent: true });
    return { deleted: original.storageDirPath };
  }, (r) => r);

  await step('restore with a wrong password is refused', async () => {
    const dataDir = await freshDir('restore_bad');
    return expectRejects('restore with a wrong password', () =>
      restoreFromBackup({ backupFilePath, password: 'not-the-password', dataDir })
    );
  }, (message) => ({ message }));

  const dataDir = await freshDir('restored');
  await step('restoreFromBackup', () => restoreFromBackup({ backupFilePath, password: PASSWORD, dataDir }), (r) => r);

  const restored = await step('open restored wallet', () =>
    bootRgbLibWallet(ctx.unlockParams, { label: 'restored', mnemonic: original.mnemonic, storageDirPath: dataDir }),
  (r) => ({ storageDirPath: r.storageDirPath }));
  ctx.sender = restored;

  await step('restored state matches', async () => {
    await restored.wallet.refreshWallet();
    const after = await snapshot(restored.wallet);
    assertEq(JSON.stringify(after.ids), JSON.stringify(before.ids), 'asset ids');
    for (const id of before.ids) assertEq(after.balances[id], before.balances[id], `settled balance of ${id}`);
    assertEq(after.btc, before.btc, 'BTC balance (vanilla + colored, settled)');
    return after;
  }, (s) => s);

  if (!niaAssetId) return;
  // The restored wallet must still own its allocations, not just display them.
  const receiver = ctx.receiver.wallet;
  const receivedBefore = await settledBalance(receiver, niaAssetId);
  const invoice = await step('receiver blindReceive', () =>
    receiver.blindReceive({ amount: SEND_AFTER_RESTORE }),
  (r) => r);
  const sent = await step('restored wallet sends', () =>
    restored.wallet.onchainSend({ invoice: invoice.invoice, assetId: niaAssetId }),
  (r) => r);
  assert(HEX_32.test(sent.txid), 'send txid must be 64 hex chars');
  await step('send from the restored wallet settles', () =>
    settle('restored send to settle', [receiver, restored.wallet], async () =>
      (await settledBalance(receiver, niaAssetId)) === receivedBefore + SEND_AFTER_RESTORE
    )
  );
}
