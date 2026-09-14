import {
  createWallet,
  PasswordRLNSigner,
  UTEXOWallet,
} from '@utexo/rgb-sdk-rn';
import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';

import { sendToAddressUtexo } from '@/utils/bitcoin-node';
import { buildUtexoConfig } from '@/utils/env';
import {
  beginExclusiveFlow,
  createFlowResults,
  endExclusiveFlow,
  sleep,
} from '@/utils/flow-core';

// VSS (Versioned Storage Service) flow — UTEXO testnet.
//
// Structure mirrors runRlnVssFlow (regtest): nodeA is VSS-backed, nodeB is plain.
// Creates UTXOs + NIA asset, opens a BTC channel nodeA→nodeB (waits up to 20 min
// for testnet confirmation), then wipes nodeA local state and restores from VSS,
// verifying that both the pubkey and channel list survive the restore.
//
// HTTPS is supported; vssAllowHttp is enabled only for an explicit HTTP URL.
// Funding uses the faucet and polls for confirmation. Missing funds or channel
// confirmation fail the flow so a partial run cannot pass as a restore test.
export async function runRlnUtexoVssFlow() {
  const flowName = 'runRlnUtexoVssFlow';
  beginExclusiveFlow(flowName);
  const { results, addStep, failFlow } = createFlowResults();

  let wallet: UTEXOWallet | null = null;
  let nodeB: UTEXOWallet | null = null;
  let walletRestored: UTEXOWallet | null = null;

  // TEMP: minimal reproduction using the configured UTEXO VSS endpoint.
  const backupOnly = process.env.EXPO_PUBLIC_UTEXO_VSS_BACKUP_ONLY === '1';

  try {
    const { network, unlockParams } = buildUtexoConfig();
    const vssUrl = process.env.EXPO_PUBLIC_UTEXO_VSS_URL?.trim() ?? null;

    if (!vssUrl) throw new Error('EXPO_PUBLIC_UTEXO_VSS_URL not set — add it to .env');
    console.log('[vss] configuration', JSON.stringify({ network, vssUrl, backupOnly, unlockParams }));
    // Flow-local tuning: keep independent from other tests/flows.
    // Fund as: utxo target size * count + safety buffer for fees/change.
    const targetUtxoCount = 3;
    const targetUtxoSizeSat = 32500;
    const faucetSafetyBufferSat = 1130000;
    const faucetAmountSat = targetUtxoSizeSat * targetUtxoCount + faucetSafetyBufferSat;
    const channelCapacitySat = 100000;

    const keysA = await createWallet(network);
    const password = 'vssFlowPass';
    const ts = Date.now();
    const basePort = 26000 + Math.floor(Math.random() * 4000);

    const storageDirAUri = `${documentDirectory ?? ''}rln_vss_utx_a_${ts}`;
    await FileSystem.makeDirectoryAsync(storageDirAUri, { intermediates: true });
    const storageDirA = storageDirAUri.replace('file://', '');
    // 1 — create nodeA (VSS-enabled) + nodeB (plain)
    addStep('vssCreateWallets', 'running');
    console.log('[vss] walletA params', JSON.stringify({
      storageDirPath: storageDirA,
      daemonListeningPort: basePort,
      ldkPeerListeningPort: basePort + 1,
      network,
      vssUrl,
      vssAllowHttp: vssUrl.startsWith('http://'),
      vssAllowEmptyRestore: true,
    }));
    console.log('[vss] unlockParams', JSON.stringify(unlockParams));
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
    await wallet.init();
    console.log('[vss] walletA init ✓');
    await wallet.unlock(unlockParams);
    console.log('[vss] walletA unlock ✓');

    if (backupOnly) {
      addStep('vssCreateWallets', 'success', { network, vssUrl, mode: 'init → unlock → backupNow' });
      addStep('vssBackupNow', 'running');
      console.log('[vss] walletA backupNow()', { network, vssUrl });
      const backupVersion = await wallet.backupNow();
      if (!Number.isSafeInteger(backupVersion) || backupVersion < 0) {
        throw new Error(`Invalid VSS backup version: ${backupVersion}`);
      }
      addStep('vssBackupNow', 'success', { backupVersion, mode: 'backup only; restore not tested' });
      results.success = true;
      return results;
    }

    const keysB = await createWallet(network);
    const storageDirBUri = `${documentDirectory ?? ''}rln_vss_utx_b_${ts}`;
    await FileSystem.makeDirectoryAsync(storageDirBUri, { intermediates: true });
    const storageDirB = storageDirBUri.replace('file://', '');
    console.log('[vss] walletB params', JSON.stringify({
      storageDirPath: storageDirB,
      daemonListeningPort: basePort + 100,
      ldkPeerListeningPort: basePort + 101,
      network,
    }));
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
    await nodeB.init();
    console.log('[vss] walletB init ✓');
    await nodeB.unlock(unlockParams);
    console.log('[vss] walletB unlock ✓');
    const nodeBInfo = await nodeB.getNodeInfo();
    const pubkeyB = String(nodeBInfo?.pubkey ?? '');
    console.log(`[vss] walletB pubkey=${pubkeyB} storageDirB=${storageDirB}`);
    addStep('vssCreateWallets', 'success', { vssUrl, network, pubkeyB: pubkeyB.substring(0, 16) + '...' });

    // 2 — get deposit address + poll up to 3 min for BTC balance
    addStep('vssFundWallet', 'running');
    const address = await wallet.getAddress();
    let faucetResponse: string | null = null;
    try {
      faucetResponse = await sendToAddressUtexo(address, faucetAmountSat);
    } catch (e: any) {
      console.warn(`[vss] faucet funding failed: ${e?.message ?? String(e)}`);
    }
    let balance: any = null;
    let settled = 0;
    let spendable = 0;
    const fundDeadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < fundDeadline) {
      try {
        await wallet.syncWallet();
        balance = await wallet.getBtcBalance();
        settled = Number(balance?.vanilla?.settled ?? 0);
        spendable = Number(balance?.vanilla?.spendable ?? 0);
        console.log(`[vss] funding poll settled=${settled} spendable=${spendable}`);
        // For UTXO creation we need confirmed sats; spendable/future can appear before settlement.
        if (settled >= faucetAmountSat) break;
      } catch (e: any) {
        console.warn(`[vss] waitForFunding: ${e?.message}`);
      }
      await sleep(15000);
    }
    const hasFunds = settled >= faucetAmountSat;
    if (!hasFunds) throw new Error(`Funding timeout: ${address} needs ${faucetAmountSat} settled sats, got ${settled}`);
    addStep('vssFundWallet', 'success', {
      address,
      faucetAmountSat,
      faucetResponse,
      settled,
      spendable,
      balance,
      hasFunds,
    });

    // 3 — create UTXOs for RGB operations
    addStep('vssCreateUtxos', 'running');
    await wallet.syncWallet();
    const coloredBefore = Number((await wallet.getBtcBalance()).colored.settled);
    await wallet.createUtxos({
      upTo: false,
      num: targetUtxoCount,
      feeRate: 3,
      size: targetUtxoSizeSat,
    });
    const utxoDeadline = Date.now() + 45 * 60 * 1000;
    let utxosConfirmed = false;
    while (Date.now() < utxoDeadline) {
      await sleep(20000);
      await wallet.syncWallet();
      const coloredSettled = Number((await wallet.getBtcBalance()).colored.settled);
      if (coloredSettled >= coloredBefore + targetUtxoCount * targetUtxoSizeSat) {
        utxosConfirmed = true;
        break;
      }
    }
    if (!utxosConfirmed) throw new Error('Timed out waiting for confirmed RGB UTXOs');
    addStep('vssCreateUtxos', 'success', { num: targetUtxoCount });

    // 4 — issue NIA asset
    addStep('vssIssueAssetNia', 'running');
    await wallet.syncWallet();
    const issued = await wallet.issueAssetNia({ ticker: 'VDMO', name: 'VssDemo', precision: 0, amounts: [500] });
    const assetId = String(issued?.assetId ?? '');
    if (!assetId) throw new Error('Failed to issue asset');
    await wallet.refreshWallet();
    const preWipeBalance = await wallet.getAssetBalance(assetId);
    addStep('vssIssueAssetNia', 'success', { assetId: assetId.substring(0, 20) + '...', spendable: preWipeBalance?.spendable });

    // 5 — open BTC channel nodeA → nodeB (wait up to 20 min for testnet confirmation)
    addStep('vssOpenChannel', 'running');
    const peerUriB = `${pubkeyB}@127.0.0.1:${basePort + 101}`;
    console.log(`[vss] openChannel: connectPeer(${peerUriB})`);
    try {
      await wallet.connectPeer(peerUriB);
      console.log('[vss] openChannel: connectPeer ✓');
    } catch (e: any) {
      console.warn(`[vss] openChannel: connectPeer non-fatal: ${e?.message ?? String(e)}`);
    }
    await sleep(1000);
    console.log('[vss] openChannel: request', JSON.stringify({
      peerPubkey: peerUriB,
      capacitySat: channelCapacitySat,
      pushMsat: 0,
      isPublic: true,
      withAnchors: true,
    }));
    const openResp = await wallet.openChannel({
      peerPubkey: peerUriB,
      capacitySat: channelCapacitySat,
      pushMsat: 0,
      isPublic: true,
      withAnchors: true,
    });
    const tempChannelId = String(openResp?.temporaryChannelId ?? '');
    console.log(`[vss] openChannel: temporaryChannelId=${tempChannelId || '(empty)'}`);
    const channelDeadline = Date.now() + 20 * 60 * 1000;
    let channelUsable = false;
    while (Date.now() < channelDeadline) {
      await wallet.syncWallet();
      const info = await wallet.getNodeInfo();
      const usable = Number(info?.numUsableChannels ?? 0);
      const total = Number(info?.numChannels ?? 0);
      const channels = ((await wallet.listChannels().catch(() => [])) ?? []) as any[];
      const shortChannels = channels.map((c: any) => ({
        id: String(c?.channelId ?? '').substring(0, 16),
        usable: !!c?.ready,
        cap: Number(c?.capacitySat ?? 0),
        txid: String(c?.fundingTxid ?? '').substring(0, 16),
      }));
      console.log(
        `[vss] openChannel poll usable=${usable} total=${total} channels=${shortChannels.length} elapsedSec=${Math.floor((Date.now() - (channelDeadline - 20 * 60 * 1000)) / 1000)}`,
        JSON.stringify(shortChannels)
      );
      if (usable >= 1) {
        channelUsable = true;
        break;
      }
      await sleep(30000);
    }
    if (!channelUsable) {
      throw new Error('Timed out waiting for a usable channel');
    }
    const channelsA = await wallet.listChannels() ?? [];
    const channel = (channelsA as any[]).find((c: any) => c.ready);
    if (!channel?.channelId) throw new Error('No ready channel found after confirmation');
    const channelId = String(channel.channelId);
    const channelCapacity = Number(channel.capacitySat);
    addStep('vssOpenChannel', 'success', {
      channelId: channelId.substring(0, 16) + '...',
      capacitySat: Number(channel?.capacitySat ?? channelCapacitySat),
    });

    const nodeInfoA = await wallet.getNodeInfo();
    const pubkeyA = String(nodeInfoA?.pubkey ?? '');

    // 6 — shutdown nodeA, delete local state
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
    const restoreDirUri = `${documentDirectory ?? ''}rln_vss_utx_restore_${ts}`;
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

    // 8 — verify restored state: pubkey, channels
    addStep('vssVerifyRestoredWallet', 'running');
    const restoredInfo = await walletRestored!.getNodeInfo();
    const restoredPubkey = String(restoredInfo?.pubkey ?? '');
    console.log(`[vss] restored pubkey=${restoredPubkey.substring(0, 16)}...`);

    await walletRestored!.syncWallet();
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
      channelsRestored: restoredChannels.length,
      channelFound: !!restoredChannel,
    });

    // 9 — verify RGB asset balance after restore
    addStep('vssVerifyAssetBalance', 'running');
    let restoredAssets: any = null;
    let restoredAssetBalance: any = null;
    let assetBalanceError: string | null = null;
    if (assetId) {
      try {
        await walletRestored!.syncWallet();
        await walletRestored!.refreshWallet();
        restoredAssets = await walletRestored!.listAssets();
        console.log(`[vss] restored listAssets nia=${restoredAssets?.nia?.length ?? 0}`);
        restoredAssetBalance = await walletRestored!.getAssetBalance(assetId);
        console.log('[vss] restored assetBalance:', JSON.stringify(restoredAssetBalance));
      } catch (e: any) {
        assetBalanceError = `${e?.message ?? e} (${e?.code ?? 'unknown'})`;
        console.warn('[vss] asset balance after restore FAILED:', assetBalanceError);
      }
    }
    if (assetBalanceError) throw new Error(assetBalanceError);
    if (!restoredAssets?.nia?.some((asset: { assetId: string }) => asset.assetId === assetId)) {
      throw new Error(`Restored wallet is missing asset ${assetId}`);
    }
    if (preWipeBalance?.settled == null || restoredAssetBalance?.settled !== preWipeBalance.settled) {
      throw new Error('Restored RGB settled balance does not match the backup');
    }
    addStep('vssVerifyAssetBalance', 'success', {
      assetId: assetId ? assetId.substring(0, 20) + '...' : null,
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
