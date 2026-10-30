import { createWallet, PasswordRLNSigner, UTEXOWallet } from '@utexo/rgb-sdk-rn';
import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';

import { buildMainnetConfig } from '@/utils/env';
import { beginExclusiveFlow, createFlowResults, endExclusiveFlow } from '@/utils/flow-core';

// Minimal mainnet smoke test: create → init → unlock → get receive address.
// No funding, UTXOs, or channels — this flow never moves real BTC.
export async function runMainnetInitFlow() {
  const flowName = 'runMainnetInitFlow';
  beginExclusiveFlow(flowName);
  const { results, addStep, failFlow } = createFlowResults();

  let node: UTEXOWallet<'RGB_LN'> | null = null;

  try {
    const { network, unlockParams } = buildMainnetConfig();
    const keys = await createWallet(network);
    const password = 'mainnetDemoPass';

    const basePort = 40000 + Math.floor(Math.random() * 5000);
    const ts = Date.now();
    const storageDirUri = `${documentDirectory ?? ''}rln_mainnet_${ts}`;
    await FileSystem.makeDirectoryAsync(storageDirUri, { intermediates: true });
    const storageDir = storageDirUri.replace('file://', '');

    node = new UTEXOWallet(
      {
        storageDirPath: storageDir,
        daemonListeningPort: basePort,
        ldkPeerListeningPort: basePort + 1,
        network,
        enableVirtualChannelsV0: false,
      },
      new PasswordRLNSigner(password, keys.mnemonic),
    );

    addStep('mainnetInitNode', 'running');
    await node.init();
    addStep('mainnetInitNode', 'success', { storageDirPath: storageDir });

    addStep('mainnetUnlockNode', 'running');
    await node.unlock(unlockParams);
    addStep('mainnetUnlockNode', 'success', {});

    addStep('mainnetGetAddress', 'running');
    const address = await node.getAddress();
    addStep('mainnetGetAddress', 'success', { address });

    results.success = true;
    return results;
  } catch (error: any) {
    return failFlow(flowName, error);
  } finally {
    if (node) { try { await node.destroy(); } catch {} }
    endExclusiveFlow(flowName);
  }
}
