import {
  createWallet,
  NativeExternalRLNSigner,
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
} from '@/utils/flow-core';

/**
 * Wait until every node reports a usable channel, mining between polls.
 * Mirrors the SDK's WaitOptions.onEachPoll pattern (UtexoLsp.waitForChannel),
 * which the bare UTEXOWallet does not expose. The readiness loop must advance
 * the chain itself — otherwise the (colored) funding tx never accrues
 * confirmations to minimum_depth and numUsableChannels stays 0.
 */
async function waitForUsableChannels(
  nodes: [UTEXOWallet<'RGB_LN'>, string][],
  opts: {
    minUsable?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
    onEachPoll?: () => Promise<void>;
  } = {},
): Promise<void> {
  const minUsable = opts.minUsable ?? 1;
  const timeoutMs = opts.timeoutMs ?? 180000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (opts.onEachPoll) await opts.onEachPoll();
    const usables = await Promise.all(
      nodes.map(async ([node]) => {
        await node.syncWallet();
        return Number((await node.getNodeInfo())?.numUsableChannels ?? 0);
      }),
    );
    nodes.forEach(([, label], i) =>
      console.log(`[wAsExt] ${label} usableChannels=${usables[i]} (need ${minUsable})`),
    );
    if (usables.every((u) => u >= minUsable)) return;
    await sleep(pollIntervalMs);
  }
  throw new Error(`channels not usable within timeout (need ${minUsable} per node)`);
}

export async function runRlnUtexoWalletAssetChannelExtSignerFlow() {
  const flowName = 'runRlnUtexoWalletAssetChannelExtSignerFlow';
  beginExclusiveFlow(flowName);
  const { results, addStep, failFlow } = createFlowResults();

  let nodeA: UTEXOWallet<'RGB_LN'> | null = null;
  let nodeB: UTEXOWallet<'RGB_LN'> | null = null;

  try {
    const { network, unlockParams } = buildRegtestConfig();

    const keysA = await createWallet(network);
    const keysB = await createWallet(network);
    const nodeAPassword = 'nodeApass';

    const basePortA = 20000 + Math.floor(Math.random() * 10000);
    const basePortB = basePortA + 100;
    const ts = Date.now();
    const storageDirUriA = `${documentDirectory ?? ''}rln_asext_a_${ts}`;
    const storageDirUriB = `${documentDirectory ?? ''}rln_asext_b_${ts}`;
    await FileSystem.makeDirectoryAsync(storageDirUriA, { intermediates: true });
    await FileSystem.makeDirectoryAsync(storageDirUriB, { intermediates: true });
    const storageDirA = storageDirUriA.replace('file://', '');
    const storageDirB = storageDirUriB.replace('file://', '');

    // nodeA — regular node (PasswordRLNSigner): issues asset, opens asset channel, pays
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

    // nodeB — external signer node (NativeExternalRLNSigner): creates invoices
    nodeB = new UTEXOWallet(
      {
        storageDirPath: storageDirB,
        daemonListeningPort: basePortB,
        ldkPeerListeningPort: basePortB + 1,
        network,
        enableVirtualChannelsV0: false,
      },
      new NativeExternalRLNSigner(keysB.mnemonic, network),
    );

    // 1 — init nodeA
    addStep('wAsExtAInit', 'running');
    await nodeA.init();
    addStep('wAsExtAInit', 'success', { storageDirPath: storageDirA });

    // 2 — unlock nodeA
    addStep('wAsExtAUnlock', 'running');
    await nodeA.unlock(unlockParams);
    addStep('wAsExtAUnlock', 'success', {});

    // 3 — init nodeB
    addStep('wAsExtBInit', 'running');
    await nodeB.init();
    addStep('wAsExtBInit', 'success', { storageDirPath: storageDirB });

    // 4 — unlock nodeB
    addStep('wAsExtBUnlock', 'running');
    await nodeB.unlock(unlockParams);
    addStep('wAsExtBUnlock', 'success', {});

    // 5 — node infos
    const infoA = await nodeA.getNodeInfo();
    const infoB = await nodeB.getNodeInfo();
    const pubkeyA = String(infoA?.pubkey ?? '');
    const pubkeyB = String(infoB?.pubkey ?? '');
    addStep('wAsExtNodeInfos', 'success', {
      pubkeyA: pubkeyA.substring(0, 16) + '...',
      pubkeyB: pubkeyB.substring(0, 16) + '...',
    });

    // 6 — fund nodeA
    addStep('wAsExtAFund', 'running');
    const addrA = await nodeA.getAddress();
    const txidA = await sendToAddress(addrA, 1);
    await mine(6);
    await sleep(3000);
    await nodeA.syncWallet();
    const balA = await nodeA.getBtcBalance();
    addStep('wAsExtAFund', 'success', { txid: txidA, address: addrA, balance: balA });

    // 7 — create UTXOs for nodeA
    addStep('wAsExtACreateUtxos', 'running');
    await nodeA.syncWallet();
    await nodeA.createUtxos({ upTo: false, num: 10, feeRate: 7 });
    await mine(1);
    await nodeA.syncWallet();
    addStep('wAsExtACreateUtxos', 'success', { num: 10 });

    // 8 — fund nodeB
    addStep('wAsExtBFund', 'running');
    const addrB = await nodeB.getAddress();
    const txidB = await sendToAddress(addrB, 1);
    await mine(6);
    await sleep(3000);
    await nodeB.syncWallet();
    const balB = await nodeB.getBtcBalance();
    addStep('wAsExtBFund', 'success', { txid: txidB, address: addrB, balance: balB });

    // 9 — create UTXOs for nodeB
    addStep('wAsExtBCreateUtxos', 'running');
    await nodeB.syncWallet();
    await nodeB.createUtxos({ upTo: false, num: 10, feeRate: 7 });
    await mine(1);
    await nodeB.syncWallet();
    addStep('wAsExtBCreateUtxos', 'success', { num: 10 });

    // 10 — issue asset on nodeA (regular node)
    addStep('wAsExtIssueAsset', 'running');
    const issued = await nodeA.issueAssetNia({ ticker: 'USDT', name: 'Tether', precision: 0, amounts: [1000] });
    const assetId = String(issued?.assetId ?? '');
    if (!assetId) throw new Error('Failed to issue asset');
    addStep('wAsExtIssueAsset', 'success', { assetId });

    // 11 — connect peers nodeA → nodeB
    addStep('wAsExtConnectPeers', 'running');
    const peerUriB = `${pubkeyB}@127.0.0.1:${basePortB + 1}`;
    const peerUriA = `${pubkeyA}@127.0.0.1:${basePortA + 1}`;
    console.log(`[wAsExt] connecting nodeA → ${peerUriB}`);
    try {
      await nodeA.connectPeer(peerUriB);
      console.log(`[wAsExt] connected to ${peerUriB}`);
    } catch (e: any) {
      if (isPoisonLike(e)) {
        addStep('wAsExtConnectPeers', 'error', undefined, e?.message ?? String(e));
        throw e;
      }
      console.warn(`[wAsExt] connectPeer ignored: ${e?.message ?? String(e)}`);
    }
    addStep('wAsExtConnectPeers', 'success', { peerUriB });

    // 12 — open asset channel nodeA → nodeB (600 units, 100k sat)
    // pushMsat can be non-zero: channel_signer.rs now derives the real push value
    // (derive_initial_push_value_msat) and passes it to VLS SetupChannel, so the acceptor
    // validates the holder commitment correctly. (Previously it hardcoded push_value_msat=0.)
    addStep('wAsExtOpenChannel', 'running');
    await nodeA.openChannel({
      peerPubkey: peerUriB,
      capacitySat: 100000,
      pushMsat: 3_500_000,
      isPublic: false,
      withAnchors: true,
      assetId,
      assetLocalAmount: 600,
    });

    let fundingTxid = '';
    let channelId = '';
    const fundDeadline = Date.now() + 120000;
    while (Date.now() < fundDeadline) {
      await nodeA.syncWallet();
      const channels: any[] = (await nodeA.listChannels()) ?? [];
      const ch = channels.find(
        (c: any) => (c.assetId ?? c.asset_id) === assetId && (c.fundingTxid ?? c.funding_txid) != null,
      );
      if (ch) {
        fundingTxid = String(ch.fundingTxid ?? ch.funding_txid ?? '');
        channelId = String(ch.channelId ?? ch.channel_id ?? '');
        break;
      }
      await sleep(1000);
    }
    if (!fundingTxid) throw new Error('Timeout waiting for funding tx');
    console.log(`[wAsExt] channelId=${channelId} fundingTxid=${fundingTxid}`);

    // Let the async colored-funding broadcast reach the mempool before mining.
    await sleep(2000);
    await waitForUsableChannels([[nodeA, 'nodeA'], [nodeB, 'nodeB']], {
      onEachPoll: async () => { await mine(1); },
    });
    addStep('wAsExtOpenChannel', 'success', { channelId, fundingTxid, assetId });

    // log asset balances after channel open to confirm push worked
    const balAfterA = await nodeA.getAssetBalance(assetId).catch(() => null);
    const balAfterB = await nodeB.getAssetBalance(assetId).catch(() => null);
    console.log(`[wAsExt] assetBalance after open — nodeA: ${JSON.stringify(balAfterA)}, nodeB: ${JSON.stringify(balAfterB)}`);
    const channelsA = await nodeA.listChannels().catch(() => []);
    const channelsB = await nodeB.listChannels().catch(() => []);
    console.log(`[wAsExt] nodeA channels: ${JSON.stringify(channelsA)}`);
    console.log(`[wAsExt] nodeB channels: ${JSON.stringify(channelsB)}`);

    // 13 — payment 1: nodeB (ext signer) creates asset invoice, nodeA (regular) pays
    addStep('wAsExtPayment1', 'running');
    const inv1 = await nodeB.createLightningInvoice({ amountSats: 3000, expirySeconds: 900, asset: { assetId, amount: 100 } });
    console.log(`[wAsExt] createLightningInvoice raw response: ${JSON.stringify(inv1)}`);
    const invoice1 = String(inv1?.lnInvoice ?? '');
    console.log(`[wAsExt] invoice1 type=${typeof inv1?.lnInvoice} length=${invoice1.length} first60="${invoice1.substring(0, 60)}"`);
    console.log(`[wAsExt] invoice1 charCodes(0-5): ${Array.from(invoice1.substring(0, 6)).map(c => c.charCodeAt(0)).join(',')}`);
    console.log(`[wAsExt] calling nodeA.payLightningInvoice with invoice1`);
    const send1 = await nodeA.payLightningInvoice({ lnInvoice: invoice1 });
    const hash1 = String(send1?.txid ?? '');
    console.log(`[wAsExt] payment1 hash=${hash1}`);
    const pay1Deadline = Date.now() + 60000;
    while (Date.now() < pay1Deadline) {
      await nodeA.syncWallet();
      const status = await nodeA.getLightningSendStatus(hash1);
      console.log(`[wAsExt] payment1 status=${status}`);
      if (status === 'Succeeded') break;
      if (status === 'Failed') throw new Error(`Payment1 failed: ${hash1}`);
      await sleep(2000);
    }
    addStep('wAsExtPayment1', 'success', { paymentHash: hash1, assetAmount: 100 });

    // 14 — restart nodeA (shutdown + reinit on same instance)
    addStep('wAsExtRestartNodeA', 'running');
    await nodeA.shutdown();
    await sleep(1000);
    await nodeA.reinit(unlockParams);
    console.log('[wAsExt] nodeA restarted via UTEXOWallet.reinit()');
    const restartDeadline = Date.now() + 120000;
    while (Date.now() < restartDeadline) {
      await nodeA.syncWallet();
      const info = await nodeA.getNodeInfo();
      const usable = Number(info?.numUsableChannels ?? 0);
      console.log(`[wAsExt] nodeA usableChannels after restart=${usable}`);
      if (usable >= 1) break;
      await sleep(2000);
    }
    addStep('wAsExtRestartNodeA', 'success', {});

    // 15 — payment 2: nodeB creates invoice, nodeA pays (after restart)
    addStep('wAsExtPayment2', 'running');
    const inv2 = await nodeB.createLightningInvoice({ amountSats: 3000, expirySeconds: 900, asset: { assetId, amount: 50 } });
    const invoice2 = String(inv2?.lnInvoice ?? '');
    console.log(`[wAsExt] invoice2: ${invoice2.substring(0, 40)}...`);
    const send2 = await nodeA.payLightningInvoice({ lnInvoice: invoice2 });
    const hash2 = String(send2?.txid ?? '');
    console.log(`[wAsExt] payment2 hash=${hash2}`);
    const pay2Deadline = Date.now() + 60000;
    while (Date.now() < pay2Deadline) {
      await nodeA.syncWallet();
      const status = await nodeA.getLightningSendStatus(hash2);
      console.log(`[wAsExt] payment2 status=${status}`);
      if (status === 'Succeeded') break;
      if (status === 'Failed') throw new Error(`Payment2 failed: ${hash2}`);
      await sleep(2000);
    }
    addStep('wAsExtPayment2', 'success', { paymentHash: hash2, assetAmount: 50 });

    // 16 — cooperative close channel nodeA → nodeB
    // After payments: nodeA channel=450, nodeB channel=150; nodeA off-chain=400
    // Expected after close: nodeA=850 (400+450), nodeB=150
    addStep('wAsExtCloseChannel', 'running');
    try { await nodeA.syncWallet(); } catch {}
    try { await nodeB.syncWallet(); } catch {}
    await nodeA.closeChannel(channelId, pubkeyB, false);
    await mine(6);
    await nodeA.refreshWallet();
    await nodeB.refreshWallet();
    await sleep(20000);
    await mine(6);
    await nodeA.refreshWallet();
    await nodeB.refreshWallet();
    await sleep(20000);
    await mine(6);
    await nodeA.refreshWallet();
    await nodeB.refreshWallet();
    addStep('wAsExtCloseChannel', 'success', { channelId });

    // 17 — wait for on-chain balances to settle
    addStep('wAsExtWaitBalances', 'running');
    const balDeadline = Date.now() + 170000;
    let lastSpendableA = -1;
    let lastSpendableB = -1;
    while (Date.now() < balDeadline) {
      try {
        const b = await nodeA.getAssetBalance(assetId);
        lastSpendableA = Number(b?.spendable ?? -1);
        console.log(`[wAsExt] waitBal nodeA spendable=${lastSpendableA} expected=850`);
      } catch (e: any) { console.warn(`[wAsExt] waitBal nodeA: ${e?.message}`); }
      try {
        const b = await nodeB.getAssetBalance(assetId);
        lastSpendableB = Number(b?.spendable ?? -1);
        console.log(`[wAsExt] waitBal nodeB spendable=${lastSpendableB} expected=150`);
      } catch (e: any) { console.warn(`[wAsExt] waitBal nodeB: ${e?.message}`); }
      if (lastSpendableA === 850 && lastSpendableB === 150) break;
      try { await nodeA.refreshWallet(); } catch {}
      try { await nodeB.refreshWallet(); } catch {}
      await sleep(12000);
    }
    if (lastSpendableA !== 850) throw new Error(`nodeA balance did not reach 850, last=${lastSpendableA}`);
    if (lastSpendableB !== 150) throw new Error(`nodeB balance did not reach 150, last=${lastSpendableB}`);
    addStep('wAsExtWaitBalances', 'success', { expectedA: 850, expectedB: 150 });

    // TODO iteration 2: nodeA → nodeB second channel (original direction)
    // addStep('wAsExt2ConnectPeers', 'running');
    // ...
    // addStep('wAsExt2OpenChannel', 'running');  // nodeA opens 500-unit channel to nodeB
    // ...
    // addStep('wAsExt2Payment', 'running');       // nodeB creates invoice, nodeA pays 100 units
    // ...
    // addStep('wAsExt2CloseChannel', 'running');  // nodeA closes, expected A=750, B=250
    // ...
    // addStep('wAsExt2WaitBalances', 'running');
    // ...

    // 18 — reconnect peers for second channel (nodeB signer → nodeA password)
    // NativeExternalRLNSigner (VLS) is the channel initiator here; this tests whether VLS
    // can open a channel. FundingGenerationReady is known to loop without producing a funding
    // tx when VLS is the funder — this step will time out if that Rust-layer bug is present.
    addStep('wAsExtRevConnectPeers', 'running');
    try {
      await nodeB.connectPeer(peerUriA);
    } catch (e: any) {
      if (isPoisonLike(e)) {
        addStep('wAsExtRevConnectPeers', 'error', undefined, e?.message ?? String(e));
        throw e;
      }
      console.warn(`[wAsExt] rev connectPeer ignored: ${e?.message ?? String(e)}`);
    }
    addStep('wAsExtRevConnectPeers', 'success', { peerUriA });

    // 19 — open second channel nodeB (VLS) → nodeA (100 units, 100k sat)
    // nodeB off-chain=150; nodeB puts 100 units into channel (off-chain→50), pushMsat to nodeA.
    // Channel after open: nodeB=100 units, nodeA=0 units.
    addStep('wAsExtRevOpenChannel', 'running');
    await nodeB.syncWallet();
    await nodeB.openChannel({
      peerPubkey: peerUriA,
      capacitySat: 100000,
      pushMsat: 3_500_000,
      isPublic: false,
      withAnchors: true,
      assetId,
      assetLocalAmount: 100,
    });

    let revFundingTxid = '';
    let revChannelId = '';
    const revFundDeadline = Date.now() + 120000;
    // nodeB is the initiator, so assetId appears in nodeB.listChannels().
    while (Date.now() < revFundDeadline) {
      await nodeB.syncWallet();
      const channels: any[] = (await nodeB.listChannels()) ?? [];
      const ch = channels.find(
        (c: any) =>
          (c.assetId ?? c.asset_id) === assetId &&
          (c.fundingTxid ?? c.funding_txid) != null,
      );
      if (ch) {
        revFundingTxid = String(ch.fundingTxid ?? ch.funding_txid ?? '');
        revChannelId = String(ch.channelId ?? ch.channel_id ?? '');
        break;
      }
      await sleep(1000);
    }
    if (!revFundingTxid) throw new Error('Timeout waiting for reverse funding tx');
    console.log(`[wAsExt] rev channelId=${revChannelId} fundingTxid=${revFundingTxid}`);

    // listChannels() returns fundingTxid as soon as FundingCreated is sent, but with
    // NativeExternalRLNSigner the VLS signing on the initiator (nodeB) side takes several
    // seconds, so the funding tx may not be broadcast yet. Mine on each poll until the
    // reverse channel is usable — both nodes must reach 2 usable channels (forward + reverse),
    // otherwise the still-usable forward channel would let a `>= 1` check pass immediately.
    await sleep(5000);
    await waitForUsableChannels([[nodeA, 'nodeA'], [nodeB, 'nodeB']], {
      minUsable: 2,
      onEachPoll: async () => { await mine(1); },
    });
    addStep('wAsExtRevOpenChannel', 'success', { channelId: revChannelId, fundingTxid: revFundingTxid, assetId });

    // 20 — payment: nodeA creates invoice (50 units), nodeB (VLS initiator) pays
    // Channel: nodeB=100, nodeA=0; after payment: nodeB=50, nodeA=50
    addStep('wAsExtRevPayment', 'running');
    const invRev = await nodeA.createLightningInvoice({ amountSats: 3000, expirySeconds: 900, asset: { assetId, amount: 50 } });
    const invoiceRev = String(invRev?.lnInvoice ?? '');
    const sendRev = await nodeB.payLightningInvoice({ lnInvoice: invoiceRev });
    const hashRev = String(sendRev?.txid ?? '');
    console.log(`[wAsExt] rev payment hash=${hashRev}`);
    const revPayDeadline = Date.now() + 60000;
    while (Date.now() < revPayDeadline) {
      await nodeB.syncWallet();
      const status = await nodeB.getLightningSendStatus(hashRev);
      console.log(`[wAsExt] rev payment status=${status}`);
      if (status === 'Succeeded') break;
      if (status === 'Failed') throw new Error(`Rev payment failed: ${hashRev}`);
      await sleep(2000);
    }
    addStep('wAsExtRevPayment', 'success', { paymentHash: hashRev, assetAmount: 50 });

    // 21 — cooperative close reverse channel (nodeA initiates)
    // Expected after close: nodeA=850+50=900, nodeB=50+50=100
    addStep('wAsExtRevCloseChannel', 'running');
    try { await nodeA.syncWallet(); } catch {}
    try { await nodeB.syncWallet(); } catch {}
    await nodeA.closeChannel(revChannelId, pubkeyB, false);
    await mine(6);
    await nodeA.refreshWallet();
    await nodeB.refreshWallet();
    await sleep(20000);
    await mine(6);
    await nodeA.refreshWallet();
    await nodeB.refreshWallet();
    await sleep(20000);
    await mine(6);
    await nodeA.refreshWallet();
    await nodeB.refreshWallet();
    addStep('wAsExtRevCloseChannel', 'success', { channelId: revChannelId });

    // 22 — wait for settled balances: A=900, B=100
    addStep('wAsExtRevWaitBalances', 'running');
    const revBalDeadline = Date.now() + 300000;
    let lastSpendableRevA = -1;
    let lastSpendableRevB = -1;
    while (Date.now() < revBalDeadline) {
      try {
        const b = await nodeA.getAssetBalance(assetId);
        lastSpendableRevA = Number(b?.spendable ?? -1);
        console.log(`[wAsExt] rev waitBal nodeA spendable=${lastSpendableRevA} expected=900`);
      } catch (e: any) { console.warn(`[wAsExt] rev waitBal nodeA: ${e?.message}`); }
      try {
        const b = await nodeB.getAssetBalance(assetId);
        lastSpendableRevB = Number(b?.spendable ?? -1);
        console.log(`[wAsExt] rev waitBal nodeB spendable=${lastSpendableRevB} expected=100`);
      } catch (e: any) { console.warn(`[wAsExt] rev waitBal nodeB: ${e?.message}`); }
      if (lastSpendableRevA === 900 && lastSpendableRevB === 100) break;
      try { await nodeA.refreshWallet(); } catch {}
      try { await nodeB.refreshWallet(); } catch {}
      await sleep(12000);
    }
    if (lastSpendableRevA !== 900) throw new Error(`nodeA rev balance did not reach 900, last=${lastSpendableRevA}`);
    if (lastSpendableRevB !== 100) throw new Error(`nodeB rev balance did not reach 100, last=${lastSpendableRevB}`);
    addStep('wAsExtRevWaitBalances', 'success', { expectedA: 900, expectedB: 100 });

    // TODO iteration 2: nodeB RGB on-chain sends 150 back to nodeA
    addStep('wAsExtRgbSendBtoA', 'running');
    const invA = await nodeA.blindReceive({ minConfirmations: 1 });
    await nodeB.onchainSend({ invoice: invA.invoice, assetId, amount: 150, donation: true, feeRate: 1, minConfirmations: 1 });
    await mine(1);
    await nodeA.syncWallet();
    await nodeA.refreshWallet();
    await nodeA.refreshWallet();
    await nodeB.refreshWallet();
    addStep('wAsExtRgbSendBtoA', 'success', { amount: 150, recipientId: invA.recipientId.substring(0, 20) + '...' });

    // TODO iteration 2: final balances: A=1000, B=0
    addStep('wAsExtFinalBalances', 'running');
    const [finalA, finalB] = await Promise.all([
      nodeA.getAssetBalance(assetId),
      nodeB.getAssetBalance(assetId).catch(() => ({ spendable: 0 })),
    ]);
    addStep('wAsExtFinalBalances', 'success', {
      spendableA: finalA?.spendable ?? null,
      spendableB: finalB?.spendable ?? null,
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
