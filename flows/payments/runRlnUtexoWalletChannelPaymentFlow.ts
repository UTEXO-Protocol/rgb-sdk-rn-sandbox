import {
  createWallet,
  PasswordRLNSigner,
  UTEXOWallet,
} from '@utexo/rgb-sdk-rn';
import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';

import { mine, sendToAddress } from '@/utils/bitcoin-node';
import { buildRegtestConfig } from '@/utils/env';
import {
  beginExclusiveFlow,
  createFlowResults,
  endExclusiveFlow,
  isPoisonLike,
  sleep,
  waitForAssetSpendable,
} from '@/utils/flow-core';
import { wChanValidate } from '@/utils/validate';

export async function runRlnUtexoWalletChannelPaymentFlow() {
  const flowName = 'runRlnUtexoWalletChannelPaymentFlow';
  beginExclusiveFlow(flowName);
  const { results, addStep, failFlow } = createFlowResults();

  let nodeA: UTEXOWallet<'RGB_LN'> | null = null;
  let nodeB: UTEXOWallet<'RGB_LN'> | null = null;

  try {
    const { network, unlockParams } = buildRegtestConfig();

    const keysA = await createWallet(network);
    const keysB = await createWallet(network);
    const nodeAPassword = 'nodeApass';
    const nodeBPassword = 'nodeBpass';

    const basePortA = 20000 + Math.floor(Math.random() * 10000);
    const basePortB = basePortA + 100;
    const ts = Date.now();
    const storageDirUriA = `${documentDirectory ?? ''}rln_wallet_chan_a_${ts}`;
    const storageDirUriB = `${documentDirectory ?? ''}rln_wallet_chan_b_${ts}`;
    await FileSystem.makeDirectoryAsync(storageDirUriA, { intermediates: true });
    await FileSystem.makeDirectoryAsync(storageDirUriB, { intermediates: true });
    const storageDirA = storageDirUriA.replace('file://', '');
    const storageDirB = storageDirUriB.replace('file://', '');

    nodeA = new UTEXOWallet(
      {
        storageDirPath: storageDirA,
        daemonListeningPort: basePortA,
        ldkPeerListeningPort: basePortA + 1,
        network,
        enableVirtualChannelsV0: false,
      },
      new PasswordRLNSigner(nodeAPassword, keysA.mnemonic),
    );

    nodeB = new UTEXOWallet(
      {
        storageDirPath: storageDirB,
        daemonListeningPort: basePortB,
        ldkPeerListeningPort: basePortB + 1,
        network,
        enableVirtualChannelsV0: false,
      },
      new PasswordRLNSigner(nodeBPassword, keysB.mnemonic),
    );

    // 1 — init nodeA (createNode + signer.initNode)
    addStep('wChanAInit', 'running');
    await nodeA.init();
    addStep('wChanAInit', 'success', { storageDirPath: storageDirA });

    // 2 — unlock nodeA
    addStep('wChanAUnlock', 'running');
    await nodeA.unlock(unlockParams);
    addStep('wChanAUnlock', 'success', {});

    // 3 — init nodeB (createNode + signer.initNode)
    addStep('wChanBInit', 'running');
    await nodeB.init();
    addStep('wChanBInit', 'success', { storageDirPath: storageDirB });

    // 4 — unlock nodeB (PasswordRLNSigner injects password automatically)
    addStep('wChanBUnlock', 'running');
    await nodeB.unlock(unlockParams);
    addStep('wChanBUnlock', 'success', {});

    // 5 — node infos
    // getNodeInfo() → RlnNodeInfo { pubkey, numUsableChannels, numChannels, localBalanceMsat, peers[] }
    const infoA = await nodeA.getNodeInfo();
    const infoB = await nodeB.getNodeInfo();
    const pubkeyA = String(infoA?.pubkey ?? '');
    const pubkeyB = String(infoB?.pubkey ?? '');
    const nodeInfoSchema = { pubkey: 'nonempty-string', numUsableChannels: 'number', numChannels: 'number', localBalanceMsat: 'number', peers: 'array' };
    const vInfoA = wChanValidate('getNodeInfo(nodeA)', infoA, nodeInfoSchema);
    const vInfoB = wChanValidate('getNodeInfo(nodeB)', infoB, nodeInfoSchema);
    addStep('wChanNodeInfos', 'success', {
      pubkeyA: pubkeyA.substring(0, 16) + '...',
      pubkeyB: pubkeyB.substring(0, 16) + '...',
      _v: { nodeA: { match: vInfoA.match, fields: vInfoA.fields }, nodeB: { match: vInfoB.match, fields: vInfoB.fields } },
    });

    // 6 — fund nodeA
    // getAddress() → string (bech32)
    // getBtcBalance() → BtcBalance { vanilla: { spendable, future, immature }, colored: { spendable, future, immature } }
    addStep('wChanAFund', 'running');
    const addrA = await nodeA.getAddress();
    const vAddrA = wChanValidate('getAddress(nodeA)', { address: addrA }, { address: 'nonempty-string' });
    const txidA = await sendToAddress(addrA, 1);
    await mine(6);
    await sleep(3000);
    await nodeA.syncWallet();
    const balA = await nodeA.getBtcBalance();
    const vBalA = wChanValidate('getBtcBalance(nodeA)', balA, { vanilla: 'object', colored: 'object' });
    addStep('wChanAFund', 'success', { txid: txidA, address: addrA, balance: balA,
      _v: { address: { match: vAddrA.match }, balance: { match: vBalA.match, fields: vBalA.fields, vanilla: balA?.vanilla, colored: balA?.colored } } });

    // 7 — create UTXOs for nodeA
    addStep('wChanACreateUtxos', 'running');
    await nodeA.syncWallet();
    await nodeA.createUtxos({ upTo: false, num: 10, feeRate: 7 });
    await mine(1);
    await nodeA.syncWallet();
    addStep('wChanACreateUtxos', 'success', { num: 10 });

    // 8 — fund nodeB
    addStep('wChanBFund', 'running');
    const addrB = await nodeB.getAddress();
    const vAddrB = wChanValidate('getAddress(nodeB)', { address: addrB }, { address: 'nonempty-string' });
    const txidB = await sendToAddress(addrB, 1);
    await mine(6);
    await sleep(3000);
    await nodeB.syncWallet();
    const balB = await nodeB.getBtcBalance();
    const vBalB = wChanValidate('getBtcBalance(nodeB)', balB, { vanilla: 'object', colored: 'object' });
    addStep('wChanBFund', 'success', { txid: txidB, address: addrB, balance: balB,
      _v: { address: { match: vAddrB.match }, balance: { match: vBalB.match, fields: vBalB.fields, vanilla: balB?.vanilla, colored: balB?.colored } } });

    // 9 — create UTXOs for nodeB
    addStep('wChanBCreateUtxos', 'running');
    await nodeB.syncWallet();
    await nodeB.createUtxos({ upTo: false, num: 10, feeRate: 7 });
    await mine(1);
    await nodeB.syncWallet();
    addStep('wChanBCreateUtxos', 'success', { num: 10 });

    // 10 — connect peers nodeA → nodeB
    addStep('wChanConnectPeers', 'running');
    const peerUriB = `${pubkeyB}@127.0.0.1:${basePortB + 1}`;
    console.log(`[wChan] connecting nodeA → ${peerUriB}`);
    try {
      await nodeA.connectPeer(peerUriB);
      console.log(`[wChan] connected to ${peerUriB}`);
    } catch (e: any) {
      if (isPoisonLike(e)) {
        addStep('wChanConnectPeers', 'error', undefined, e?.message ?? String(e));
        throw e;
      }
      console.warn(`[wChan] connectPeer ignored: ${e?.message ?? String(e)}`);
    }
    addStep('wChanConnectPeers', 'success', { peerUriB });

    // 11 — open BTC channel nodeA → nodeB (500k sat, no asset)
    // openChannel() → RlnOpenChannelResponse { temporaryChannelId: string }
    // listChannels() → RlnChannel[] — each: { channelId, fundingTxid, isUsable, capacitySat, localBalanceMsat, ... }
    addStep('wChanOpenChannel', 'running');
    const openResp = await nodeA.openChannel({
      peerPubkey: peerUriB,
      capacitySat: 500000,
      pushMsat: 0,
      isPublic: false,
      withAnchors: true,
      assetId: undefined,
      assetLocalAmount: undefined,
    });
    const vOpenResp = wChanValidate('openChannel(nodeA)', openResp, { temporaryChannelId: 'nonempty-string' });
    const tmpId = String(openResp?.temporaryChannelId ?? '');
    console.log(`[wChan] opened channel tmpId=${tmpId}`);

    let fundingTxid = '';
    let channelId = '';
    let foundChannel: any = null;
    const fundDeadline = Date.now() + 120000;
    while (Date.now() < fundDeadline) {
      await nodeA.syncWallet();
      const channels: any[] = (await nodeA.listChannels()) ?? [];
      const ch = channels.find((c: any) => (c.fundingTxid ?? c.funding_txid) != null);
      if (ch) {
        foundChannel = ch;
        fundingTxid = String(ch.fundingTxid ?? ch.funding_txid ?? '');
        channelId = String(ch.channelId ?? ch.channel_id ?? '');
        break;
      }
      await sleep(1000);
    }
    if (!fundingTxid) throw new Error('Timeout waiting for funding tx');
    const vChannel = wChanValidate('listChannels(nodeA)[found]', foundChannel, {
      channelId: 'nonempty-string', fundingTxid: 'nonempty-string',
      capacitySat: 'number', localBalanceMsat: 'number',
    });
    console.log(`[wChan] channelId=${channelId} fundingTxid=${fundingTxid}`);

    await mine(6);
    await sleep(3000);
    for (const [node, label] of [[nodeA, 'nodeA'], [nodeB, 'nodeB']] as [UTEXOWallet<'RGB_LN'>, string][]) {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await node.syncWallet();
        const info = await node.getNodeInfo();
        const usable = Number(info?.numUsableChannels ?? 0);
        console.log(`[wChan] ${label} usableChannels=${usable}`);
        if (usable >= 1) break;
        await sleep(2000);
      }
    }
    addStep('wChanOpenChannel', 'success', { channelId, fundingTxid,
      _v: { openChannel: { match: vOpenResp.match, fields: vOpenResp.fields }, channel: { match: vChannel.match, fields: vChannel.fields, received: foundChannel } } });

    // 12 — payment 1: nodeB creates invoice, nodeA pays
    // createLightningInvoice() → { lnInvoice: string, amountMsat?: number, expirySeconds: number }
    // payLightningInvoice() → { txid: string }
    // getLightningSendStatus(hash) → status string: 'Pending' | 'Succeeded' | 'Failed'
    addStep('wChanPayment1', 'running');
    const inv1 = await nodeB.createLightningInvoice({ amountSats: 3000, expirySeconds: 900, asset: { assetId: '', amount: 0 } });
    const vInv1 = wChanValidate('createLightningInvoice(nodeB)', inv1, { lnInvoice: 'nonempty-string' });
    const invoice1 = String(inv1?.lnInvoice ?? '');
    console.log(`[wChan] invoice1: ${invoice1.substring(0, 40)}...`);
    const send1 = await nodeA.payLightningInvoice({ lnInvoice: invoice1 });
    const vSend1 = wChanValidate('payLightningInvoice(nodeA)', send1, { txid: 'nonempty-string' });
    const hash1 = String(send1?.txid ?? '');
    console.log(`[wChan] payment1 hash=${hash1}`);
    let status1 = '';
    const pay1Deadline = Date.now() + 60000;
    while (Date.now() < pay1Deadline) {
      await nodeA.syncWallet();
      status1 = String((await nodeA.getLightningSendStatus(hash1)) ?? '');
      console.log(`[wChan] payment1 status=${status1}`);
      if (status1 === 'Succeeded') break;
      if (status1 === 'Failed') throw new Error(`Payment1 failed: ${hash1}`);
      await sleep(2000);
    }
    const vStatus1 = wChanValidate('getLightningSendStatus(nodeA) payment1', { status: status1 }, { status: 'nonempty-string' });
    addStep('wChanPayment1', 'success', { paymentHash: hash1,
      _v: { invoice: { match: vInv1.match, fields: vInv1.fields }, pay: { match: vSend1.match, fields: vSend1.fields }, status: { value: status1, settled: status1 === 'Succeeded' } } });

    // 13 — restart nodeA (shutdown + reinit on same instance — no manager recreation needed)
    addStep('wChanRestartNodeA', 'running');
    await nodeA.shutdown();
    await sleep(1000);
    await nodeA.reinit(unlockParams);
    console.log('[wChan] nodeA restarted via UTEXOWallet.reinit()');
    const restartDeadline = Date.now() + 120000;
    while (Date.now() < restartDeadline) {
      await nodeA.syncWallet();
      const info = await nodeA.getNodeInfo();
      const usable = Number(info?.numUsableChannels ?? 0);
      console.log(`[wChan] nodeA usableChannels after restart=${usable}`);
      if (usable >= 1) break;
      await sleep(2000);
    }
    addStep('wChanRestartNodeA', 'success', {});

    // 14 — payment 2: nodeB creates invoice, nodeA pays (after restart)
    addStep('wChanPayment2', 'running');
    const inv2 = await nodeB.createLightningInvoice({ amountSats: 3000, expirySeconds: 900, asset: { assetId: '', amount: 0 } });
    const vInv2 = wChanValidate('createLightningInvoice(nodeB)', inv2, { lnInvoice: 'nonempty-string' });
    const invoice2 = String(inv2?.lnInvoice ?? '');
    console.log(`[wChan] invoice2: ${invoice2.substring(0, 40)}...`);
    const send2 = await nodeA.payLightningInvoice({ lnInvoice: invoice2 });
    const vSend2 = wChanValidate('payLightningInvoice(nodeA)', send2, { txid: 'nonempty-string' });
    const hash2 = String(send2?.txid ?? '');
    console.log(`[wChan] payment2 hash=${hash2}`);
    let status2 = '';
    const pay2Deadline = Date.now() + 60000;
    while (Date.now() < pay2Deadline) {
      await nodeA.syncWallet();
      status2 = String((await nodeA.getLightningSendStatus(hash2)) ?? '');
      console.log(`[wChan] payment2 status=${status2}`);
      if (status2 === 'Succeeded') break;
      if (status2 === 'Failed') throw new Error(`Payment2 failed: ${hash2}`);
      await sleep(2000);
    }
    addStep('wChanPayment2', 'success', { paymentHash: hash2,
      _v: { invoice: { match: vInv2.match, fields: vInv2.fields }, pay: { match: vSend2.match, fields: vSend2.fields }, status: { value: status2, settled: status2 === 'Succeeded' } } });

    // 15 — issue RGB asset on nodeA (1000 units)
    // issueAssetNia() → AssetNIA { assetId, ticker, name, precision, issuedSupply, timestamp, addedAt, balance: { spendable, future, settled } }
    addStep('wChanIssueAsset', 'running');
    await nodeA.syncWallet();
    const issued = await nodeA.issueAssetNia({ ticker: 'WCTS', name: 'WalletChanTest', precision: 0, amounts: [1000] });
    const vIssued = wChanValidate('issueAssetNia(nodeA)', issued, {
      assetId: 'nonempty-string', ticker: 'nonempty-string', name: 'nonempty-string',
      precision: 'number', issuedSupply: 'number', balance: 'object',
    });
    const assetId = String(issued?.assetId ?? '');
    await mine(1);
    await nodeA.syncWallet();
    await nodeA.refreshWallet();
    addStep('wChanIssueAsset', 'success', { assetId: assetId.substring(0, 20) + '...',
      _v: { match: vIssued.match, fields: vIssued.fields, received: { ticker: issued?.ticker, name: issued?.name, precision: issued?.precision, issuedSupply: issued?.issuedSupply, balance: issued?.balance } } });

    // 16 — nodeB generates witness invoice (nodeA will send 300 units with witnessData)
    // witnessReceive() → InvoiceReceiveData { invoice: string, recipientId: string, batchTransferIdx: number, expirationTimestamp?: number }
    // assetId/amount omitted: nodeB doesn't own the asset yet; passing them causes "resource not found"
    addStep('wChanWitnessReceive', 'running');
    await nodeB.syncWallet();
    const invWitness = await nodeB.witnessReceive({ minConfirmations: 1 });
    const vInvWitness = wChanValidate('witnessReceive(nodeB)', invWitness, {
      invoice: 'nonempty-string', recipientId: 'nonempty-string', batchTransferIdx: 'number',
    });
    const witnessInvoice = String(invWitness?.invoice ?? '');
    const witnessRecipientId = String(invWitness?.recipientId ?? '');
    console.log(`[wChan] witnessInvoice recipientId=${witnessRecipientId.substring(0, 20)}...`);
    addStep('wChanWitnessReceive', 'success', { recipientId: witnessRecipientId.substring(0, 20) + '...',
      _v: { match: vInvWitness.match, fields: vInvWitness.fields, received: { recipientId: witnessRecipientId.substring(0, 20) + '...', batchTransferIdx: invWitness?.batchTransferIdx } } });

    // 17 — nodeA sends 300 units to nodeB via witness invoice (witnessData.amountSat=1000)
    // send() → SendResult { txid: string, batchTransferIdx: number }
    // listOnchainTransfers(assetId) → Transfer[] — each: { kind, status, txid?, amount, assetId, ... }
    // listAssets() → ListAssets { nia?: AssetNIA[], cfa?: AssetCFA[], uda?: AssetUDA[] }
    addStep('wChanSendWitness', 'running');
    const sendWitness = await nodeA.onchainSend({
      invoice: witnessInvoice,
      assetId,
      amount: 300,
      donation: true,
      feeRate: 1,
      minConfirmations: 1,
      witnessData: { amountSat: 1000 },
    });
    const vSendWitness = wChanValidate('onchainSend(nodeA, witness)', sendWitness, { txid: 'nonempty-string', batchTransferIdx: 'number' });
    await mine(1);
    await nodeA.syncWallet();
    await nodeB.syncWallet();
    await nodeA.refreshWallet();
    await nodeB.refreshWallet();
    await nodeB.refreshWallet();
    const transfersWitness = await nodeA.listOnchainTransfers(assetId);
    const vTransfersW = wChanValidate('listOnchainTransfers(nodeA)', { transfers: transfersWitness }, { transfers: 'array' });
    const assetsAfterWitness = await nodeA.listAssets();
    const vAssetsW = wChanValidate('listAssets(nodeA)', assetsAfterWitness, { nia: 'array' });
    console.log(`[wChan] after witness send: transferCount=${transfersWitness.length} assetCount=${assetsAfterWitness?.nia?.length ?? 0}`);
    addStep('wChanSendWitness', 'success', {
      amount: 300,
      recipientId: witnessRecipientId.substring(0, 20) + '...',
      transferCount: transfersWitness.length,
      _v: {
        send: { match: vSendWitness.match, fields: vSendWitness.fields, received: sendWitness },
        transfers: { match: vTransfersW.match, count: transfersWitness.length, sample: transfersWitness[0] ?? null },
        assets: { match: vAssetsW.match, niaCount: assetsAfterWitness?.nia?.length ?? 0 },
      },
    });

    // 18 — nodeB generates blind invoice (nodeA will send 200 units, no witnessData)
    // blindReceive() → InvoiceReceiveData { invoice: string, recipientId: string, batchTransferIdx: number, expirationTimestamp?: number }
    // assetId/amount omitted: nodeB receives for the first time; asset not yet in its db
    addStep('wChanBlindReceive', 'running');
    await nodeB.syncWallet();
    const invBlind = await nodeB.blindReceive({ minConfirmations: 1 });
    const vInvBlind = wChanValidate('blindReceive(nodeB)', invBlind, {
      invoice: 'nonempty-string', recipientId: 'nonempty-string', batchTransferIdx: 'number',
    });
    const blindInvoice = String(invBlind?.invoice ?? '');
    const blindRecipientId = String(invBlind?.recipientId ?? '');
    console.log(`[wChan] blindInvoice recipientId=${blindRecipientId.substring(0, 20)}...`);
    addStep('wChanBlindReceive', 'success', { recipientId: blindRecipientId.substring(0, 20) + '...',
      _v: { match: vInvBlind.match, fields: vInvBlind.fields, received: { recipientId: blindRecipientId.substring(0, 20) + '...', batchTransferIdx: invBlind?.batchTransferIdx } } });

    // 19 — nodeA sends 200 units to nodeB via blind invoice (no witnessData)
    // TEMP(esplora): wait for the prior witness send's change to confirm (spendable>=200)
    // before starting the next colored send. Remove when switching back to Electrum.
    await waitForAssetSpendable(nodeA, assetId, 200, { mine, attempts: 30, delayMs: 1000, label: 'wChan nodeA' });
    addStep('wChanSendBlind', 'running');
    const sendBlind = await nodeA.onchainSend({
      invoice: blindInvoice,
      assetId,
      amount: 200,
      donation: true,
      feeRate: 1,
      minConfirmations: 1,
    });
    const vSendBlind = wChanValidate('onchainSend(nodeA, blind)', sendBlind, { txid: 'nonempty-string', batchTransferIdx: 'number' });
    await mine(1);
    await nodeA.syncWallet();
    await nodeB.syncWallet();
    await nodeA.refreshWallet();
    await nodeB.refreshWallet();
    await nodeB.refreshWallet();
    const transfersBlind = await nodeA.listOnchainTransfers(assetId);
    const vTransfersB = wChanValidate('listOnchainTransfers(nodeA)', { transfers: transfersBlind }, { transfers: 'array' });
    const assetsAfterBlind = await nodeA.listAssets();
    const vAssetsB = wChanValidate('listAssets(nodeA)', assetsAfterBlind, { nia: 'array' });
    console.log(`[wChan] after blind send: transferCount=${transfersBlind.length} assetCount=${assetsAfterBlind?.nia?.length ?? 0}`);
    addStep('wChanSendBlind', 'success', {
      amount: 200,
      recipientId: blindRecipientId.substring(0, 20) + '...',
      transferCount: transfersBlind.length,
      _v: {
        send: { match: vSendBlind.match, fields: vSendBlind.fields, received: sendBlind },
        transfers: { match: vTransfersB.match, count: transfersBlind.length, sample: transfersBlind[0] ?? null },
        assets: { match: vAssetsB.match, niaCount: assetsAfterBlind?.nia?.length ?? 0 },
      },
    });

    // 20 — final asset balances: nodeA=500, nodeB=500
    // getAssetBalance(assetId) → AssetBalance { spendable: number, future: number, settled: number }
    addStep('wChanFinalBalances', 'running');
    const [finalBalA, finalBalB] = await Promise.all([
      nodeA.getAssetBalance(assetId),
      nodeB.getAssetBalance(assetId),
    ]);
    const balSchema = { spendable: 'number', future: 'number', settled: 'number' };
    const vFinalA = wChanValidate('getAssetBalance(nodeA)', finalBalA, balSchema);
    const vFinalB = wChanValidate('getAssetBalance(nodeB)', finalBalB, balSchema);
    console.log(`[wChan] finalA=${finalBalA?.spendable} finalB=${finalBalB?.spendable}`);
    addStep('wChanFinalBalances', 'success', {
      spendableA: finalBalA?.spendable ?? null,
      spendableB: finalBalB?.spendable ?? null,
      _v: {
        nodeA: { match: vFinalA.match, fields: vFinalA.fields, received: finalBalA, expectedSpendable: 500, matchSpendable: finalBalA?.spendable === 500 },
        nodeB: { match: vFinalB.match, fields: vFinalB.fields, received: finalBalB, expectedSpendable: 500, matchSpendable: finalBalB?.spendable === 500 },
      },
    });

    results.success = true;
    return results;
  } catch (error: any) {
    return failFlow(flowName, error);
  } finally {
    if (nodeA) { try { await nodeA.destroy(); } catch {} }
    if (nodeB) { try { await nodeB.destroy(); } catch {} }
    endExclusiveFlow(flowName);
  }
}
