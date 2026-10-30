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
  sleep,
} from '@/utils/flow-core';

// nodeB (Password) issues asset and sends on-chain to nodeA (ext signer).
// nodeA then sends back — exercises rgb_send_begin → rgb_sign_psbt → rgb_send_end.
export async function runExtSignerOnchainSendFlow() {
  const flowName = 'runExtSignerOnchainSendFlow';
  beginExclusiveFlow(flowName);
  const { results, addStep, failFlow } = createFlowResults();

  let nodeA: UTEXOWallet<'RGB_LN'> | null = null; // NativeExternalRLNSigner
  let nodeB: UTEXOWallet<'RGB_LN'> | null = null; // PasswordRLNSigner

  try {
    const { network, unlockParams } = buildRegtestConfig();

    const keysA = await createWallet(network);
    const keysB = await createWallet(network);
    const nodeBPassword = 'nodeBpass';

    const basePortA = 23000 + Math.floor(Math.random() * 5000);
    const basePortB = basePortA + 100;
    const ts = Date.now();
    const storageDirUriA = `${documentDirectory ?? ''}rln_ext_onchain_a_${ts}`;
    const storageDirUriB = `${documentDirectory ?? ''}rln_ext_onchain_b_${ts}`;
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
      new NativeExternalRLNSigner(keysA.mnemonic, network),
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

    addStep('extOsAInit', 'running');
    await nodeA.init();
    addStep('extOsAInit', 'success', { storageDirPath: storageDirA });

    addStep('extOsAUnlock', 'running');
    await nodeA.unlock(unlockParams);
    addStep('extOsAUnlock', 'success', {});

    addStep('extOsBInit', 'running');
    await nodeB.init();
    addStep('extOsBInit', 'success', { storageDirPath: storageDirB });

    addStep('extOsBUnlock', 'running');
    await nodeB.unlock(unlockParams);
    addStep('extOsBUnlock', 'success', {});

    addStep('extOsAFund', 'running');
    const addrA = await nodeA.getAddress();
    await sendToAddress(addrA, 1);
    await mine(6);
    await sleep(3000);
    await nodeA.syncWallet();
    const balA = await nodeA.getBtcBalance();
    addStep('extOsAFund', 'success', { balance: balA });

    addStep('extOsACreateUtxos', 'running');
    await nodeA.createUtxos({ upTo: false, num: 10, feeRate: 7 });
    await mine(1);
    await nodeA.syncWallet();
    addStep('extOsACreateUtxos', 'success', { num: 10 });

    addStep('extOsBFund', 'running');
    const addrB = await nodeB.getAddress();
    await sendToAddress(addrB, 1);
    await mine(6);
    await sleep(3000);
    await nodeB.syncWallet();
    const balB = await nodeB.getBtcBalance();
    addStep('extOsBFund', 'success', { balance: balB });

    addStep('extOsBCreateUtxos', 'running');
    await nodeB.createUtxos({ upTo: false, num: 10, feeRate: 7 });
    await mine(1);
    await nodeB.syncWallet();
    addStep('extOsBCreateUtxos', 'success', { num: 10 });

    // nodeB (password) issues — issuance is blocked in ext signer mode
    addStep('extOsIssueAsset', 'running');
    const issued = await nodeB.issueAssetNia({ ticker: 'XSND', name: 'ExtSend', precision: 0, amounts: [1000] });
    const assetId = String(issued?.assetId ?? '');
    if (!assetId) throw new Error('Failed to issue asset');
    addStep('extOsIssueAsset', 'success', { assetId });

    // nodeB → nodeA on-chain: nodeA (ext signer) does blindReceive, nodeB sends 500
    addStep('extOsSendToExt', 'running');
    const invA = await nodeA.blindReceive({ minConfirmations: 1 });
    await nodeB.onchainSend({ invoice: invA.invoice, assetId, amount: 500, donation: true, feeRate: 1, minConfirmations: 1 });
    await mine(1);
    await nodeA.syncWallet();
    await nodeA.refreshWallet();
    await nodeA.refreshWallet();
    await nodeB.refreshWallet();
    addStep('extOsSendToExt', 'success', { amount: 500, recipientId: invA.recipientId.substring(0, 20) + '...' });

    // wait for nodeA spendable = 500
    addStep('extOsWaitExtBalance', 'running');
    const deadline = Date.now() + 60000;
    let spendable = -1;
    while (Date.now() < deadline) {
      try {
        const b = await nodeA.getAssetBalance(assetId);
        spendable = Number(b?.spendable ?? -1);
        console.log(`[extOs] nodeA spendable=${spendable} expected=500`);
        if (spendable === 500) break;
      } catch (e: any) { console.warn(`[extOs] waitBal: ${e?.message}`); }
      try { await nodeA.refreshWallet(); } catch {}
      await sleep(2000);
    }
    if (spendable !== 500) throw new Error(`nodeA balance did not reach 500, last=${spendable}`);
    addStep('extOsWaitExtBalance', 'success', { spendable });

    // nodeA (ext signer) → nodeB: exercises rgb_send_begin → rgb_sign_psbt → rgb_send_end
    addStep('extOsSendFromExt', 'running');
    await nodeA.syncWallet();
    await nodeA.refreshWallet();
    const invB = await nodeB.blindReceive({ minConfirmations: 1 });
    await nodeA.onchainSend({ invoice: invB.invoice, assetId, amount: 250, donation: true, feeRate: 1, minConfirmations: 1 });
    await mine(1);
    await nodeB.syncWallet();
    await nodeB.refreshWallet();
    await nodeB.refreshWallet();
    await nodeA.refreshWallet();
    addStep('extOsSendFromExt', 'success', { amount: 250, recipientId: invB.recipientId.substring(0, 20) + '...' });

    // Final: nodeA=250, nodeB=750
    addStep('extOsFinalBalances', 'running');
    const [finalA, finalB] = await Promise.all([
      nodeA.getAssetBalance(assetId),
      nodeB.getAssetBalance(assetId),
    ]);
    addStep('extOsFinalBalances', 'success', {
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
