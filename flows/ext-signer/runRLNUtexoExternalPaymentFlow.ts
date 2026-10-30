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

export async function runRLNUtexoExternalPaymentFlow() {
  const flowName = 'runRLNUtexoExternalPaymentFlow';
  beginExclusiveFlow(flowName);
  const { results, addStep, failFlow } = createFlowResults();

  let nodeA: UTEXOWallet<'RGB_LN'> | null = null;
  let nodeB: UTEXOWallet<'RGB_LN'> | null = null;
  let nodeC: UTEXOWallet<'RGB_LN'> | null = null;

  try {
    const { network, unlockParams } = buildRegtestConfig();

    const keysA = await createWallet(network);
    const keysB = await createWallet(network);
    const keysC = await createWallet(network);
    const nodeAPassword = 'nodeApass';
    const nodeCPassword = 'nodeCpass';

    const basePortA = 22000 + Math.floor(Math.random() * 5000);
    const basePortB = basePortA + 100;
    const basePortC = basePortA + 200;
    const ts = Date.now();
    const storageDirUriA = `${documentDirectory ?? ''}rln_xpay_a_${ts}`;
    const storageDirUriB = `${documentDirectory ?? ''}rln_xpay_b_${ts}`;
    const storageDirUriC = `${documentDirectory ?? ''}rln_xpay_c_${ts}`;
    await FileSystem.makeDirectoryAsync(storageDirUriA, { intermediates: true });
    await FileSystem.makeDirectoryAsync(storageDirUriB, { intermediates: true });
    await FileSystem.makeDirectoryAsync(storageDirUriC, { intermediates: true });
    const storageDirA = storageDirUriA.replace('file://', '');
    const storageDirB = storageDirUriB.replace('file://', '');
    const storageDirC = storageDirUriC.replace('file://', '');

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
    // nodeB uses NativeExternalRLNSigner — VLS in-process transport
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
    nodeC = new UTEXOWallet(
      {
        storageDirPath: storageDirC,
        daemonListeningPort: basePortC,
        ldkPeerListeningPort: basePortC + 1,
        network,
        enableVirtualChannelsV0: false,
      },
      new PasswordRLNSigner(nodeCPassword, keysC.mnemonic),
    );

    addStep('xPayAInit', 'running');
    await nodeA.init();
    addStep('xPayAInit', 'success', { storageDirPath: storageDirA });

    addStep('xPayAUnlock', 'running');
    await nodeA.unlock(unlockParams);
    addStep('xPayAUnlock', 'success', {});

    addStep('xPayBInit', 'running');
    await nodeB.init();
    addStep('xPayBInit', 'success', { storageDirPath: storageDirB });

    addStep('xPayBUnlock', 'running');
    await nodeB.unlock(unlockParams);
    addStep('xPayBUnlock', 'success', {});

    addStep('xPayCInit', 'running');
    await nodeC.init();
    addStep('xPayCInit', 'success', { storageDirPath: storageDirC });

    addStep('xPayCUnlock', 'running');
    await nodeC.unlock(unlockParams);
    addStep('xPayCUnlock', 'success', {});

    addStep('xPayAFund', 'running');
    const addrA = await nodeA.getAddress();
    const txidA = await sendToAddress(addrA, 1);
    await mine(6);
    await sleep(3000);
    await nodeA.syncWallet();
    const balA = await nodeA.getBtcBalance();
    addStep('xPayAFund', 'success', { txid: txidA, address: addrA, balance: balA });

    addStep('xPayACreateUtxos', 'running');
    await nodeA.syncWallet();
    await nodeA.createUtxos({ upTo: false, num: 10, feeRate: 7 });
    await mine(1);
    await nodeA.syncWallet();
    addStep('xPayACreateUtxos', 'success', { num: 10 });

    addStep('xPayBFund', 'running');
    const addrB = await nodeB.getAddress();
    const txidB = await sendToAddress(addrB, 1);
    await mine(6);
    await sleep(3000);
    await nodeB.syncWallet();
    const balB = await nodeB.getBtcBalance();
    addStep('xPayBFund', 'success', { txid: txidB, address: addrB, balance: balB });

    addStep('xPayBCreateUtxos', 'running');
    await nodeB.syncWallet();
    await nodeB.createUtxos({ upTo: false, num: 10, feeRate: 7 });
    await mine(1);
    await nodeB.syncWallet();
    addStep('xPayBCreateUtxos', 'success', { num: 10 });

    addStep('xPayCFund', 'running');
    const addrC = await nodeC.getAddress();
    const txidC = await sendToAddress(addrC, 1);
    await mine(6);
    await sleep(3000);
    await nodeC.syncWallet();
    const balC = await nodeC.getBtcBalance();
    addStep('xPayCFund', 'success', { txid: txidC, address: addrC, balance: balC });

    addStep('xPayCCreateUtxos', 'running');
    await nodeC.syncWallet();
    await nodeC.createUtxos({ upTo: false, num: 10, feeRate: 7 });
    await mine(1);
    await nodeC.syncWallet();
    addStep('xPayCCreateUtxos', 'success', { num: 10 });

    addStep('xPayIssueAsset', 'running');
    const issued = await nodeA.issueAssetNia({ ticker: 'USDT', name: 'Tether', precision: 0, amounts: [1000] });
    const assetId = String(issued?.assetId ?? '');
    if (!assetId) throw new Error('Failed to issue asset');
    addStep('xPayIssueAsset', 'success', { assetId });

    // issue #22/#28 — listUnspents assignment must be {type:'Fungible', amount:N} on both platforms
    const unspentsAfterIssue = await nodeA.listUnspents();
    const allocsAfterIssue = unspentsAfterIssue.flatMap((u) => u.rgbAllocations ?? []);
    console.log(`[xPay][#22] listUnspents after issue: ${allocsAfterIssue.length} allocation(s)`);
    for (const alloc of allocsAfterIssue) {
      console.log(`[xPay][#22] assignment=${JSON.stringify(alloc.assignment)} settled=${alloc.settled}`);
      if ((alloc.assignment as any)?.type === 'type') {
        console.error(`[xPay][#22] REGRESSION: assignment.type is the literal string "type" — serialization bug`);
      }
    }

    const infoA = await nodeA.getNodeInfo();
    const infoB = await nodeB.getNodeInfo();
    const pubkeyA = String(infoA?.pubkey ?? '');
    const pubkeyB = String(infoB?.pubkey ?? '');
    addStep('xPayNodeInfos', 'success', {
      pubkeyA: pubkeyA.substring(0, 16) + '...',
      pubkeyB: pubkeyB.substring(0, 16) + '...',
    });

    addStep('xPayConnectPeers', 'running');
    const peerUriB = `${pubkeyB}@127.0.0.1:${basePortB + 1}`;
    try {
      await nodeA.connectPeer(peerUriB);
    } catch (e: any) {
      if (isPoisonLike(e)) {
        addStep('xPayConnectPeers', 'error', undefined, e?.message ?? String(e));
        throw e;
      }
      console.warn(`[xPay] connectPeer ignored: ${e?.message ?? String(e)}`);
    }
    addStep('xPayConnectPeers', 'success', { peerUriB });

    // nodeA opens asset channel to nodeB (600 units pushed, 100k sat)
    addStep('xPayOpenChannel', 'running');
    await nodeA.openChannel({
      peerPubkey: peerUriB,
      capacitySat: 100000,
      pushMsat: 3_500_000,
      isPublic: true,
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
    console.log(`[xPay] channelId=${channelId} fundingTxid=${fundingTxid}`);

    await mine(6);
    await sleep(3000);
    for (const [node, label] of [[nodeA, 'nodeA'], [nodeB, 'nodeB']] as [UTEXOWallet<'RGB_LN'>, string][]) {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        await node.syncWallet();
        const info = await node.getNodeInfo();
        const usable = Number(info?.numUsableChannels ?? 0);
        console.log(`[xPay] ${label} usableChannels=${usable}`);
        if (usable >= 1) break;
        await sleep(2000);
      }
    }
    await mine(6);
    addStep('xPayOpenChannel', 'success', { channelId, fundingTxid });

    addStep('xPayAssetBalanceA', 'running');
    const bal0 = await nodeA.getAssetBalance(assetId);
    addStep('xPayAssetBalanceA', 'success', { spendable: bal0?.spendable ?? null });

    // inv1: B creates (100 asset units), A pays → A_chan=500, B_chan=100
    addStep('xPayInvoice1', 'running');
    const inv1Resp = await nodeB.createLightningInvoice({ amountSats: 3000, expirySeconds: 900, asset: { assetId, amount: 100 } });
    const invoice1 = String(inv1Resp?.lnInvoice ?? '');
    const send1Resp = await nodeA.payLightningInvoice({ lnInvoice: invoice1 });
    const hash1 = String(send1Resp?.txid ?? '');
    const pay1Deadline = Date.now() + 60000;
    while (Date.now() < pay1Deadline) {
      await nodeA.syncWallet();
      const status = await nodeA.getLightningSendStatus(hash1);
      console.log(`[xPay] inv1 sendStatus=${status}`);
      if (status === 'Succeeded') break;
      if (status === 'Failed') throw new Error(`Invoice1 payment failed: ${hash1}`);
      await sleep(2000);
    }
    addStep('xPayInvoice1', 'success', { paymentHash: hash1, assetAmount: 100 });

    // inv2: A creates (50 asset units), B pays → A_chan=550, B_chan=50
    addStep('xPayInvoice2', 'running');
    const inv2Resp = await nodeA.createLightningInvoice({ amountSats: 3000, expirySeconds: 900, asset: { assetId, amount: 50 } });
    const invoice2 = String(inv2Resp?.lnInvoice ?? '');
    const send2Resp = await nodeB.payLightningInvoice({ lnInvoice: invoice2 });
    const hash2 = String(send2Resp?.txid ?? '');
    const pay2Deadline = Date.now() + 60000;
    while (Date.now() < pay2Deadline) {
      await nodeB.syncWallet();
      const status = await nodeB.getLightningSendStatus(hash2);
      console.log(`[xPay] inv2 sendStatus=${status}`);
      if (status === 'Succeeded') break;
      if (status === 'Failed') throw new Error(`Invoice2 payment failed: ${hash2}`);
      await sleep(2000);
    }
    addStep('xPayInvoice2', 'success', { paymentHash: hash2, assetAmount: 50 });

    // inv3: B creates (50 asset units), A pays → A_chan=500, B_chan=100
    addStep('xPayInvoice3', 'running');
    const inv3Resp = await nodeB.createLightningInvoice({ amountSats: 3000, expirySeconds: 900, asset: { assetId, amount: 50 } });
    const invoice3 = String(inv3Resp?.lnInvoice ?? '');
    const send3Resp = await nodeA.payLightningInvoice({ lnInvoice: invoice3 });
    const hash3 = String(send3Resp?.txid ?? '');
    const pay3Deadline = Date.now() + 60000;
    while (Date.now() < pay3Deadline) {
      await nodeA.syncWallet();
      const status = await nodeA.getLightningSendStatus(hash3);
      console.log(`[xPay] inv3 sendStatus=${status}`);
      if (status === 'Succeeded') break;
      if (status === 'Failed') throw new Error(`Invoice3 payment failed: ${hash3}`);
      await sleep(2000);
    }
    addStep('xPayInvoice3', 'success', { paymentHash: hash3, assetAmount: 50 });

    // inv4: A creates (50 asset units), B pays → A_chan=550, B_chan=50
    addStep('xPayInvoice4', 'running');
    const inv4Resp = await nodeA.createLightningInvoice({ amountSats: 3000, expirySeconds: 900, asset: { assetId, amount: 50 } });
    const invoice4 = String(inv4Resp?.lnInvoice ?? '');
    const send4Resp = await nodeB.payLightningInvoice({ lnInvoice: invoice4 });
    const hash4 = String(send4Resp?.txid ?? '');
    const pay4Deadline = Date.now() + 60000;
    while (Date.now() < pay4Deadline) {
      await nodeB.syncWallet();
      const status = await nodeB.getLightningSendStatus(hash4);
      console.log(`[xPay] inv4 sendStatus=${status}`);
      if (status === 'Succeeded') break;
      if (status === 'Failed') throw new Error(`Invoice4 payment failed: ${hash4}`);
      await sleep(2000);
    }
    addStep('xPayInvoice4', 'success', { paymentHash: hash4, assetAmount: 50 });

    // Cooperative close: A=400(off-chain)+550(channel)=950, B=50
    addStep('xPayCloseChannel', 'running');
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
    addStep('xPayCloseChannel', 'success', { channelId });

    // Wait for settled balances: A=950, B=50
    addStep('xPayWaitBalances', 'running');
    const balDeadlineA = Date.now() + 70000;
    let lastSpendableA = -1;
    while (Date.now() < balDeadlineA) {
      try {
        const b = await nodeA.getAssetBalance(assetId);
        lastSpendableA = Number(b?.spendable ?? -1);
        console.log(`[xPay] waitBal nodeA spendable=${lastSpendableA} expected=950`);
        if (lastSpendableA === 950) break;
      } catch (e: any) { console.warn(`[xPay] waitBal nodeA: ${e?.message}`); }
      try { await nodeA.refreshWallet(); } catch {}
      await sleep(2000);
    }
    if (lastSpendableA !== 950) throw new Error(`nodeA balance did not reach 950, last=${lastSpendableA}`);

    const balDeadlineB = Date.now() + 70000;
    let lastSpendableB = -1;
    while (Date.now() < balDeadlineB) {
      try {
        const b = await nodeB.getAssetBalance(assetId);
        lastSpendableB = Number(b?.spendable ?? -1);
        console.log(`[xPay] waitBal nodeB spendable=${lastSpendableB} expected=50`);
        if (lastSpendableB === 50) break;
      } catch (e: any) { console.warn(`[xPay] waitBal nodeB: ${e?.message}`); }
      try { await nodeB.refreshWallet(); } catch {}
      await sleep(2000);
    }
    if (lastSpendableB !== 50) throw new Error(`nodeB balance did not reach 50, last=${lastSpendableB}`);
    addStep('xPayWaitBalances', 'success', { expectedA: 950, expectedB: 50 });

    // RGB on-chain sends to nodeC (A sends 925, B sends 25)
    addStep('xPayRgbSendA', 'running');
    const invC1 = await nodeC.blindReceive({ minConfirmations: 1, durationSeconds: 3600 });
    await nodeA.onchainSend({ invoice: invC1.invoice, assetId, amount: 925, donation: true, feeRate: 1, minConfirmations: 1 });
    await mine(1);
    await nodeC.syncWallet();
    await nodeC.refreshWallet();
    await nodeC.refreshWallet();
    await nodeA.refreshWallet();
    addStep('xPayRgbSendA', 'success', { amount: 925, recipientId: invC1.recipientId.substring(0, 20) + '...' });

    addStep('xPayRgbSendB', 'running');
    const invC2 = await nodeC.blindReceive({ minConfirmations: 1, durationSeconds: 3600 });
    await nodeB.onchainSend({ invoice: invC2.invoice, assetId, amount: 25, donation: true, feeRate: 1, minConfirmations: 1 });
    await mine(1);
    await nodeC.syncWallet();
    await nodeC.refreshWallet();
    await nodeC.refreshWallet();
    await nodeB.refreshWallet();
    addStep('xPayRgbSendB', 'success', { amount: 25, recipientId: invC2.recipientId.substring(0, 20) + '...' });

    // ── Regression diagnostics ────────────────────────────────────────────────

    addStep('xPayDiagChecks', 'running');

    // issue #22/#28 — assignment shape on nodeC after receiving
    const unspentsC = await nodeC.listUnspents();
    const allocsC = unspentsC.flatMap((u) => u.rgbAllocations ?? []);
    console.log(`[xPay][#22] nodeC listUnspents: ${allocsC.length} allocation(s)`);
    for (const alloc of allocsC) {
      console.log(`[xPay][#22] assignment=${JSON.stringify(alloc.assignment)} settled=${alloc.settled}`);
      if ((alloc.assignment as any)?.type === 'type') {
        console.error(`[xPay][#22] REGRESSION: assignment.type is literal "type" — serialization bug still present`);
      }
      if (alloc.assignment?.type === 'Fungible' && typeof alloc.assignment?.amount === 'number') {
        console.log(`[xPay][#22] ✓ Fungible assignment shape correct: amount=${alloc.assignment.amount}`);
      }
    }

    // issue #29 — Transfer.expiration field is present and correctly named
    const transfersC = await nodeC.listTransfers(assetId);
    console.log(`[xPay][#29] nodeC listTransfers: ${transfersC.length} transfer(s)`);
    for (const t of transfersC) {
      const exp = t.expiration;
      console.log(`[xPay][#29] transfer idx=${t.idx} status=${t.status} expiration=${exp ?? 'null'}`);
      if (typeof exp !== 'number') {
        console.error(`[xPay][#29] REGRESSION: expiration is ${JSON.stringify(exp)} — expected a Unix timestamp number`);
      } else {
        console.log(`[xPay][#29] ✓ expiration is a number (Unix ts=${exp}, ~${Math.round((exp - Date.now() / 1000) / 60)}min from now)`);
      }
    }

    // issue #27 — failTransfers with no batchTransferIdx returns false (no expired transfers)
    const failResultNull = await nodeC.failTransfers({ noAssetOnly: false });
    console.log(`[xPay][#27] failTransfers(undefined) transfersChanged=${failResultNull} — expected false (no expired transfers)`);
    if (failResultNull === true) {
      console.warn(`[xPay][#27] failTransfers(undefined) unexpectedly changed transfers — check for expired pending UTXOs`);
    }

    // issue #27 — failTransfers with a specific batchTransferIdx on a settled transfer should throw
    const settledTransfer = transfersC.find((t) => t.status === 'Settled');
    if (settledTransfer) {
      try {
        await nodeC.failTransfers({ batchTransferIdx: settledTransfer.batchTransferIdx, noAssetOnly: false });
        console.error(`[xPay][#27] UNEXPECTED: failTransfers on Settled transfer should have thrown CannotFailBatchTransfer`);
      } catch (e: any) {
        console.log(`[xPay][#27] ✓ failTransfers on Settled correctly threw: ${e?.message ?? String(e)}`);
      }
    }

    addStep('xPayDiagChecks', 'success', {
      allocCount: allocsC.length,
      transferCount: transfersC.length,
    });

    // ── Final balances: A=25, B=25, C=950
    addStep('xPayFinalBalances', 'running');
    const [finalA, finalB, finalC] = await Promise.all([
      nodeA.getAssetBalance(assetId),
      nodeB.getAssetBalance(assetId),
      nodeC.getAssetBalance(assetId),
    ]);
    addStep('xPayFinalBalances', 'success', {
      spendableA: finalA?.spendable ?? null,
      spendableB: finalB?.spendable ?? null,
      spendableC: finalC?.spendable ?? null,
    });

    results.success = true;
    return results;
  } catch (error: any) {
    return failFlow(flowName, error);
  } finally {
    if (nodeA) { try { await nodeA.destroy(); } catch {} }
    if (nodeB) { try { await nodeB.destroy(); } catch {} }
    if (nodeC) { try { await nodeC.destroy(); } catch {} }
    endExclusiveFlow(flowName);
  }
}
