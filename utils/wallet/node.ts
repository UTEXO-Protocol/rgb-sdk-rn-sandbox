import { generateKeys, UTEXOWallet } from '@utexo/rgb-sdk-rn';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import type { buildDemoWalletConfig } from '../env';

const PREFIX = 'utexo-devnext-v6-5010eef-wallet-v1';
function storagePath(network: string) {
  if (!FileSystem.documentDirectory) throw new Error('Native storage is unavailable');
  return `${FileSystem.documentDirectory}rgb-l1-devnext-v6-5010eef/${network}`.replace(/^file:\/\//, '');
}
export function describeWalletConfiguration(config: ReturnType<typeof buildDemoWalletConfig>) {
  return [
    'Backend: RGB_L1 · rgb-lib v6 5010eef (unmodified source)',
    `Network: ${config.network}`,
    `Indexer: ${config.unlockParams.indexer.url}`,
    `RGB proxy: ${config.unlockParams.proxyEndpoint}`,
    `Ethereum RPC (BFA): ${config.unlockParams.evmRpcUrls['42161'] || 'Not configured'}`,
    `Storage: ${storagePath(config.network)}`,
    'This update uses a new v6 wallet. Previous wallet data is preserved separately.',
  ].join('\n');
}
export async function openSavedWallet(config: ReturnType<typeof buildDemoWalletConfig>, stoppedWallet?: UTEXOWallet) {
  if (stoppedWallet) {
    await stoppedWallet.reinit(config.unlockParams);
    const identity = await stoppedWallet.getWalletIdentity();
    return { wallet: stoppedWallet, address: await stoppedWallet.getAddress(), account: `rgb:devnext:${identity.id}` };
  }
  const key = `${PREFIX}-${config.network}`;
  let mnemonic = await SecureStore.getItemAsync(key);
  if (!mnemonic) {
    const keys = await generateKeys(config.network);
    mnemonic = keys.mnemonic;
    await SecureStore.setItemAsync(key, mnemonic);
  }
  const wallet = new UTEXOWallet({
    protocol: 'RGB_L1',
    params: { network: config.network, storageDirPath: storagePath(config.network), reuseAddresses: false },
    keys: () => SecureStore.getItemAsync(key),
  });
  try {
    await wallet.init();
    await wallet.goOnline(config.unlockParams);
    const identity = await wallet.getWalletIdentity();
    return { wallet, address: await wallet.getAddress(), account: `rgb:devnext:${identity.id}` };
  } catch (error) {
    await wallet.dispose().catch(() => undefined);
    throw error;
  }
}
