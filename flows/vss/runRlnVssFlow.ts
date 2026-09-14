import { mine, sendToAddress } from '@/utils/bitcoin-node';
import { buildRegtestConfig, readEnv } from '@/utils/env';
import {
  beginExclusiveFlow,
  createFlowResults,
  endExclusiveFlow,
  sleep,
} from '@/utils/flow-core';
import {
  createWallet,
  PasswordRLNSigner,
  UTEXOWallet,
} from '@utexo/rgb-sdk-rn';
import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';

export async function runRlnVssFlow() {
  const flowName = 'runRlnVssFlow';
  beginExclusiveFlow(flowName);
  const { results, addStep, failFlow } = createFlowResults();

  let wallet: UTEXOWallet | null = null;
  let nodeB: UTEXOWallet | null = null;
  let walletRestored: UTEXOWallet | null = null;

  try {
    const { network, unlockParams } = buildRegtestConfig();
    const vssUrl = readEnv('RLN_VSS_URL')?.trim() ?? null;

    if (!vssUrl) throw new Error('EXPO_PUBLIC_RLN_VSS_URL not set — add it to .env');

    // Match the UTEXO flow; only funding, mining and confirmation timing differ.
    const targetUtxoCount = 3;
    const targetUtxoSizeSat = 32500;
    const fundingAmountSat = 1227500;
    const channelCapacitySat = 100000;
    console.log('[vss] configuration', JSON.stringify({ network, vssUrl, unlockParams }));

    const keysA = await createWallet(network);
    const keysB = await createWallet(network);
    const password = 'vssFlowPass';
    const ts = Date.now();
    const basePort = 26000 + Math.floor(Math.random() * 4000);

    const storageDirAUri = `${documentDirectory ?? ''}rln_vss_rgt_a_${ts}`;
    const storageDirBUri = `${documentDirectory ?? ''}rln_vss_rgt_b_${ts}`;
    await FileSystem.makeDirectoryAsync(storageDirAUri, { intermediates: true });
    await FileSystem.makeDirectoryAsync(storageDirBUri, { intermediates: true });
    const storageDirA = storageDirAUri.replace('file://', '');
    const storageDirB = storageDirBUri.replace('file://', '');

    // 1 — create nodeA (VSS-enabled) + nodeB (plain)
    addStep('vssCreateWallets', 'running');
    wallet = new UTEXOWallet(
      {
        storageDirPath: storageDirA,
        daemonListeningPort: basePort,
        ldkPeerListeningPort: basePort + 1,
        network,
        enableVirtualChannelsV0: false,
        vssUrl,
        vssAllowHttp: vssUrl.startsWith('http://'),
        vssAllowEmptyRestore: true,
      },
      new PasswordRLNSigner(password, keysA.mnemonic),
    );
    nodeB = new UTEXOWallet(
      {
        storageDirPath: storageDirB,
        daemonListeningPort: basePort + 100,
        ldkPeerListeningPort: basePort + 101,
        network,
        enableVirtualChannelsV0: false,
      },
      new PasswordRLNSigner(password, keysB.mnemonic),
    );
    await wallet.init();
    console.log('[vss] walletA init ✓');
    await wallet.unlock(unlockParams);
    console.log('[vss] walletA unlock ✓');
    await nodeB.init();
    await nodeB.unlock(unlockParams);
    const nodeBInfo = await nodeB.getNodeInfo();
    const pubkeyB = String(nodeBInfo?.pubkey ?? '');
    addStep('vssCreateWallets', 'success', { vssUrl, network, pubkeyB: pubkeyB.substring(0, 16) + '...' });

    // 2 — fund nodeA
    addStep('vssFundWallet', 'running');
    const address = await wallet.getAddress();
    const txid = await sendToAddress(address, fundingAmountSat / 100000000);
    await mine(6);
    await sleep(3000);
    await wallet.syncWallet();
    let btcBalance = await wallet.getBtcBalance();
    const fundingDeadline = Date.now() + 120000;
    while (btcBalance.vanilla.settled < fundingAmountSat && Date.now() < fundingDeadline) {
      await sleep(2000);
      await wallet.syncWallet();
      btcBalance = await wallet.getBtcBalance();
    }
    if (btcBalance.vanilla.settled < fundingAmountSat) throw new Error('Timed out waiting for confirmed funding');
    addStep('vssFundWallet', 'success', { txid, spendable: btcBalance?.vanilla?.spendable });

    // 3 — create UTXOs for RGB operations
    addStep('vssCreateUtxos', 'running');
    const coloredBefore = (await wallet.getBtcBalance()).colored.settled;
    await wallet.createUtxos({ upTo: false, num: targetUtxoCount, size: targetUtxoSizeSat, feeRate: 3 });
    await mine(1);
    let confirmed = false;
    const utxoDeadline = Date.now() + 120000;
    while (Date.now() < utxoDeadline) {
      await sleep(2000);
      await wallet.syncWallet();
      if ((await wallet.getBtcBalance()).colored.settled >= coloredBefore + targetUtxoCount * targetUtxoSizeSat) {
        confirmed = true;
        break;
      }
    }
    if (!confirmed) throw new Error('Timed out waiting for confirmed RGB UTXOs');
    addStep('vssCreateUtxos', 'success', { num: targetUtxoCount, size: targetUtxoSizeSat });

    // 4 — issue NIA asset
    addStep('vssIssueAssetNia', 'running');
    await wallet.syncWallet();
    const issued = await wallet.issueAssetNia({ ticker: 'VDMO', name: 'VssDemo', precision: 0, amounts: [500] });
    const assetId = String(issued?.assetId ?? '');
    if (!assetId) throw new Error('Failed to issue asset');
    await wallet.refreshWallet();
    const preWipeBalance = await wallet.getAssetBalance(assetId);
    addStep('vssIssueAssetNia', 'success', { assetId: assetId.substring(0, 20) + '...', spendable: preWipeBalance?.spendable });

    // 5 — open BTC channel nodeA → nodeB
    addStep('vssOpenChannel', 'running');
    const peerUriB = `${pubkeyB}@127.0.0.1:${basePort + 101}`;
    try { await wallet.connectPeer(peerUriB); } catch {}
    await sleep(1000);
    const openResp = await wallet.openChannel({
      peerPubkey: peerUriB,
      capacitySat: channelCapacitySat,
      pushMsat: 0,
      isPublic: true,
      withAnchors: true,
    });
    console.log('[vss] openChannel', openResp);
    await mine(6);
    await sleep(3000);
    for (const [node, label] of [[wallet, 'nodeA'], [nodeB, 'nodeB']] as [UTEXOWallet, string][]) {
      const deadline = Date.now() + 120000;
      let channelUsable = false;
      while (Date.now() < deadline) {
        await node.syncWallet();
        const info = await node.getNodeInfo();
        const usable = Number(info?.numUsableChannels ?? 0);
        console.log(`[vss] ${label} usableChannels=${usable}`);
        if (usable >= 1) {
          channelUsable = true;
          break;
        }
        await sleep(2000);
      }
      if (!channelUsable) throw new Error(`Timed out waiting for ${label} usable channel`);
    }
    const channelsA = await wallet.listChannels() ?? [];
    const channel = (channelsA as any[]).find((c: any) => c.ready);
    if (!channel?.channelId) throw new Error('Timed out waiting for a ready channel');
    const channelId = String(channel.channelId);
    const channelCapacity = Number(channel?.capacitySat ?? channelCapacitySat);
    addStep('vssOpenChannel', 'success', { channelId: channelId.substring(0, 16) + '...', capacitySat: channelCapacity });

    const nodeInfoA = await wallet.getNodeInfo();
    const pubkeyA = String(nodeInfoA?.pubkey ?? '');

    // 6 — shutdown nodeA (keep nodeB running), delete nodeA local state
    addStep('vssBackupNow', 'running');
    const backupVersion = await wallet.backupNow();
    if (!Number.isSafeInteger(backupVersion) || backupVersion < 0) {
      throw new Error(`Invalid VSS backup version: ${backupVersion}`);
    }
    addStep('vssBackupNow', 'success', { backupVersion });

    addStep('vssDeleteState', 'running');
    await wallet.shutdown();
    wallet = null;
    await FileSystem.deleteAsync(storageDirAUri, { idempotent: true });
    const restoreDirUri = `${documentDirectory ?? ''}rln_vss_rgt_restore_${ts}`;
    await FileSystem.makeDirectoryAsync(restoreDirUri, { intermediates: true });
    const restoreDir = restoreDirUri.replace('file://', '');
    addStep('vssDeleteState', 'success', { pubkeyA: pubkeyA.substring(0, 16) + '...', restoreDir });

    // 7 — restore nodeA from VSS (empty local DB → auto-restore LDK state)
    addStep('vssRestoreFromVss', 'running');
    const restorePort = basePort + 10;
    walletRestored = new UTEXOWallet(
      {
        storageDirPath: restoreDir,
        daemonListeningPort: restorePort,
        ldkPeerListeningPort: restorePort + 1,
        network,
        enableVirtualChannelsV0: false,
        vssUrl,
        vssAllowHttp: vssUrl.startsWith('http://'),
        vssAllowEmptyRestore: false,
      },
      new PasswordRLNSigner(password, keysA.mnemonic),
    );
    console.log('[vss] restore: init()');
    await walletRestored.init();
    console.log('[vss] restore: vssClearFence()');
    await walletRestored.vssClearFence(password);
    console.log('[vss] restore: unlock()');
    await walletRestored.unlock(unlockParams);
    console.log('[vss] restore: unlock() done');
    addStep('vssRestoreFromVss', 'success', { restoreDir });

    // 8 — verify restored state: pubkey, BTC balance, channel still present
    addStep('vssVerifyRestoredWallet', 'running');
    const restoredInfo = await walletRestored!.getNodeInfo();
    const restoredPubkey = String(restoredInfo?.pubkey ?? '');
    console.log(`[vss] restored pubkey=${restoredPubkey.substring(0, 16)}...`);

    await walletRestored!.syncWallet();

    let restoredBtcBalance: any = null;
    try {
      restoredBtcBalance = await walletRestored!.getBtcBalance();
      console.log('[vss] restored btcBalance:', JSON.stringify(restoredBtcBalance));
    } catch (e: any) { console.warn('[vss] getBtcBalance FAILED:', e?.message); }

    const restoredChannels = (await walletRestored!.listChannels() ?? []) as any[];
    const restoredChannel = restoredChannels.find((c: any) => c.channelId === channelId);
    console.log(`[vss] restored channels=${restoredChannels.length}`, JSON.stringify(restoredChannels.map((c: any) => ({ id: c.channelId?.substring(0, 16), isUsable: c.ready }))));

    if (!pubkeyA || restoredPubkey !== pubkeyA) {
      throw new Error('Restored node pubkey does not match the original');
    }
    if (!restoredChannel || restoredChannel.capacitySat !== channelCapacity) {
      throw new Error(`Restored channel ${channelId} is missing or has a different capacity`);
    }

    addStep('vssVerifyRestoredWallet', 'success', {
      pubkeyMatch: restoredPubkey === pubkeyA,
      pubkey: restoredPubkey.substring(0, 16) + '...',
      restoredBtcSpendable: restoredBtcBalance?.vanilla?.spendable ?? null,
      channelsRestored: restoredChannels.length,
      channelFound: !!restoredChannel,
      channelIsUsable: restoredChannel?.ready ?? false,
    });

    // 9 — verify RGB asset balance after restore
    addStep('vssVerifyAssetBalance', 'running');
    let restoredAssets: any = null;
    let restoredAssetBalance: any = null;
    let assetBalanceError: string | null = null;
    try {
      await walletRestored!.syncWallet();
      await walletRestored!.refreshWallet();
      restoredAssets = await walletRestored!.listAssets();
      console.log(`[vss] restored listAssets nia=${restoredAssets?.nia?.length ?? 0}`,
        JSON.stringify(restoredAssets?.nia?.map((a: any) => a.assetId)));
      restoredAssetBalance = await walletRestored!.getAssetBalance(assetId);
      console.log('[vss] restored assetBalance:', JSON.stringify(restoredAssetBalance));
    } catch (e: any) {
      assetBalanceError = `${e?.message ?? e} (${e?.code ?? 'unknown'})`;
      console.warn('[vss] asset balance after restore FAILED:', assetBalanceError);
    }
    if (assetBalanceError) throw new Error(assetBalanceError);
    if (!restoredAssets?.nia?.some((asset: { assetId: string }) => asset.assetId === assetId)) {
      throw new Error(`Restored wallet is missing asset ${assetId}`);
    }
    if (preWipeBalance?.settled == null || restoredAssetBalance?.settled !== preWipeBalance.settled) {
      throw new Error('Restored RGB settled balance does not match the backup');
    }
    addStep('vssVerifyAssetBalance', 'success', {
      assetId: assetId.substring(0, 20) + '...',
      preWipeSettled: preWipeBalance?.settled ?? null,
      preWipeSpendable: preWipeBalance?.spendable ?? null,
      restoredNiaCount: restoredAssets?.nia?.length ?? null,
      restoredSettled: restoredAssetBalance?.settled ?? null,
      restoredSpendable: restoredAssetBalance?.spendable ?? null,
      error: assetBalanceError,
    });

    // 10 — cleanup
    addStep('vssCleanup', 'running');
    if (walletRestored) { try { await walletRestored.destroy(); } catch {} walletRestored = null; }
    if (nodeB) { try { await nodeB.destroy(); } catch {} nodeB = null; }
    addStep('vssCleanup', 'success', {});

    results.success = true;
    return results;
  } catch (error: any) {
    return failFlow(flowName, error);
  } finally {
    if (wallet) { try { await wallet.destroy(); } catch {} }
    if (nodeB) { try { await nodeB.destroy(); } catch {} }
    if (walletRestored) { try { await walletRestored.destroy(); } catch {} }
    endExclusiveFlow(flowName);
  }
}
