import { createWallet, PasswordRLNSigner, UTEXOWallet } from '@utexo/rgb-sdk-rn';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import type { buildDemoWalletConfig } from '../env';
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function walletNodeParams(network: ReturnType<typeof buildDemoWalletConfig>['network']) {
  if (!FileSystem.documentDirectory) throw new Error('Native storage is unavailable');
  return {
    network,
    storageDirPath: `${FileSystem.documentDirectory}wallet-connect-v1/${network}`.replace(/^file:\/\//, ''),
    daemonListeningPort: 30170,
    ldkPeerListeningPort: 19750,
    reuseAddresses: true,
  };
}

/** Display the demo's initialization inputs without wallet or RPC credentials. */
export function describeWalletConfiguration(config: ReturnType<typeof buildDemoWalletConfig>) {
  const node = walletNodeParams(config.network);
  const unlock = config.unlockParams;
  return [
    `Network: ${node.network}`,
    `Indexer: ${unlock.indexerUrl ?? 'Not configured'}`,
    `RGB proxy: ${unlock.proxyEndpoint ?? 'Not configured'}`,
    `Ethereum RPC (BFA): ${unlock.ethRpcUrl ?? 'Not configured - BFA disabled'}`,
    `Bitcoin RPC host: ${unlock.bitcoindRpcHost ?? 'Not configured - using indexer'}`,
    `Bitcoin RPC port: ${unlock.bitcoindRpcPort ?? 'Not configured'}`,
    `Bitcoin RPC username: ${unlock.bitcoindRpcUsername ? 'Configured (hidden)' : 'Not configured'}`,
    `Bitcoin RPC password: ${unlock.bitcoindRpcPassword ? 'Configured (hidden)' : 'Not configured'}`,
    `Gossip RGS: ${unlock.gossipRgsServerUrl ?? 'Not configured'}`,
    `Announce addresses: ${unlock.announceAddresses?.join(', ') || 'None'}`,
    `Announce alias: ${unlock.announceAlias ?? 'Not configured'}`,
    `Daemon port: ${node.daemonListeningPort}`,
    `Lightning peer port: ${node.ldkPeerListeningPort}`,
    `Reuse addresses: ${node.reuseAddresses}`,
    `Storage: ${node.storageDirPath}`,
  ].join('\n');
}

export async function openSavedWallet(
  config: ReturnType<typeof buildDemoWalletConfig>,
  stoppedWallet?: UTEXOWallet,
) {
  if (stoppedWallet) {
    try {
      // Reuse the SDK handle after shutdown; native nodes are registered by storage path.
      await stoppedWallet.reinit(config.unlockParams);
      return {
        wallet: stoppedWallet,
        address: await stoppedWallet.getAddress(),
        account: `rgb:${config.network}:${(await stoppedWallet.getNodeInfo()).pubkey}`,
      };
    } catch (error) {
      await stoppedWallet.dispose().catch(() => undefined);
      throw error;
    }
  }
  if (!FileSystem.documentDirectory) throw new Error('Native storage is unavailable');
  const key = `utexo-demo-wallet-v1-${config.network}`;
  let credentials = await SecureStore.getItemAsync(key);
  if (!credentials) {
    const keys = await createWallet(config.network);
    const entropy = new Uint8Array(32);
    crypto.getRandomValues(entropy);
    credentials = JSON.stringify({
      mnemonic: keys.mnemonic,
      password: Array.from(entropy, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    });
    // Persist BEFORE creating any native state; retries use the same keys.
    await SecureStore.setItemAsync(key, credentials);
  }
  const { mnemonic, password } = JSON.parse(credentials);
  const dir = `${FileSystem.documentDirectory}wallet-connect-v1/${config.network}`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const wallet = new UTEXOWallet(
    walletNodeParams(config.network),
    new PasswordRLNSigner(password, mnemonic),
  );
  try {
    try {
      await wallet.init();
    } catch (error) {
      // A persisted node survives application restarts (including a crash during init).
      // RLN's UniFFI error message is "Node has already been initialized".
      if (!/\bAlreadyInitialized\b|\balready (?:been )?initialized\b/i.test(messageOf(error)))
        throw error;
    }
    await wallet.unlock(config.unlockParams);
    const address = await wallet.getAddress();
    return {
      wallet,
      address,
      account: `rgb:${config.network}:${(await wallet.getNodeInfo()).pubkey}`,
    };
  } catch (error) {
    await wallet.dispose().catch(() => undefined);
    throw error;
  }
}
