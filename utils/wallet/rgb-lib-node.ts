import {
  CallbackRgbLibKeyProvider,
  createWallet,
  UTEXOWallet,
  type RgbLibUnlockParams,
} from '@utexo/rgb-sdk-rn';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import type { DemoWalletNetwork } from '../env';

/** No implicit reuse of an RLN deployment: the two releases need compatible proxies. */
export function buildRgbLibConfig(network: DemoWalletNetwork) {
  const indexerUrl = (network === 'utexo'
    ? process.env.EXPO_PUBLIC_RGB_LIB_UTEXO_INDEXER_URL
    : process.env.EXPO_PUBLIC_RGB_LIB_REGTEST_INDEXER_URL)?.trim();
  const proxyEndpoint = (network === 'utexo'
    ? process.env.EXPO_PUBLIC_RGB_LIB_UTEXO_PROXY_ENDPOINT
    : process.env.EXPO_PUBLIC_RGB_LIB_REGTEST_PROXY_ENDPOINT)?.trim();
  const evmJson = (network === 'utexo'
    ? process.env.EXPO_PUBLIC_RGB_LIB_UTEXO_EVM_RPC_URLS
    : process.env.EXPO_PUBLIC_RGB_LIB_REGTEST_EVM_RPC_URLS)?.trim();
  const prefix = `EXPO_PUBLIC_RGB_LIB_${network.toUpperCase()}`;
  if (!indexerUrl || !proxyEndpoint) {
    throw new Error(`Set ${prefix}_INDEXER_URL and ${prefix}_PROXY_ENDPOINT in .env.local to a compatible rgb-lib deployment, then restart Metro.`);
  }
  if (!/^(tcp|ssl|https?):\/\//.test(indexerUrl)) {
    throw new Error(`${prefix}_INDEXER_URL needs tcp://, ssl://, http:// or https://.`);
  }
  if (!/^(rpcs?|https?):\/\//.test(proxyEndpoint)) {
    throw new Error(`${prefix}_PROXY_ENDPOINT needs rpc://, rpcs://, http:// or https://.`);
  }
  let evmRpcUrls: Record<string, string> | undefined;
  if (evmJson) {
    try {
      const parsed: unknown = JSON.parse(evmJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        !Object.entries(parsed).every(([chain, url]) => /^[1-9][0-9]*$/.test(chain) &&
          typeof url === 'string' && /^https?:\/\//.test(url))) throw new Error();
      evmRpcUrls = parsed as Record<string, string>;
    } catch {
      throw new Error(`${prefix}_EVM_RPC_URLS must be a JSON object mapping EVM chain IDs to HTTP(S) RPC URLs.`);
    }
  }
  return { network, unlockParams: { indexerUrl, proxyEndpoint, evmRpcUrls } satisfies RgbLibUnlockParams };
}

function storageDirectory(network: DemoWalletNetwork) {
  if (!FileSystem.documentDirectory) throw new Error('Native storage is unavailable');
  return `${FileSystem.documentDirectory}wallet-connect-v1/RGB_L1/${network}/default/taproot`;
}

function credentialsKey(network: DemoWalletNetwork) {
  return `utexo-demo-wallet-v1-RGB_L1-${network}-default-taproot`;
}

export function describeRgbLibConfiguration(network: DemoWalletNetwork) {
  const { unlockParams } = buildRgbLibConfig(network);
  return [
    'Protocol: RGB_L1 · rgb-lib',
    `Network: ${network}`,
    `Indexer: ${unlockParams.indexerUrl}`,
    `RGB proxy: ${unlockParams.proxyEndpoint}`,
    `EVM RPC chain IDs: ${Object.keys(unlockParams.evmRpcUrls ?? {}).join(', ') || 'Not configured'}`,
    'Witness: taproot',
    `Storage: ${storageDirectory(network).replace(/^file:\/\//, '')}`,
  ].join('\n');
}

// A failed native cleanup still owns the directory; retain it until cleanup succeeds.
const pendingCleanup = new Map<DemoWalletNetwork, UTEXOWallet<'RGB_L1'>>();

async function closePendingWallet(network: DemoWalletNetwork) {
  const pending = pendingCleanup.get(network);
  if (pending) {
    await pending.dispose();
    pendingCleanup.delete(network);
  }
}

/** The service must close its active/cached handle before deleting saved data. */
export async function deleteSavedRgbLibWallet(network: DemoWalletNetwork) {
  const directory = storageDirectory(network);
  const key = credentialsKey(network);
  await closePendingWallet(network);
  // A crash or partial deletion must not reopen incomplete RGB state, or create
  // a wallet with old keys. Keep this marker until both data and keys are gone.
  await SecureStore.setItemAsync(`${key}-deleting`, '1');
  await FileSystem.deleteAsync(directory, { idempotent: true });
  await SecureStore.deleteItemAsync(key);
  await SecureStore.deleteItemAsync(`${key}-deleting`);
}

export async function openSavedRgbLibWallet(network: DemoWalletNetwork, stoppedWallet?: UTEXOWallet<'RGB_L1'>) {
  const key = credentialsKey(network);
  if (await SecureStore.getItemAsync(`${key}-deleting`)) {
    throw new Error('Wallet deletion is incomplete. Retry Delete wallet before opening a new wallet.');
  }
  const config = buildRgbLibConfig(network);
  await closePendingWallet(network);
  let wallet = stoppedWallet;
  if (!wallet) {
    if (!(await SecureStore.getItemAsync(key))) {
      const { mnemonic } = await createWallet(network);
      // Persist before native state is created, including on a failed first unlock.
      await SecureStore.setItemAsync(key, mnemonic);
    }
    const directory = storageDirectory(network);
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    wallet = new UTEXOWallet({
      protocol: 'RGB_L1',
      params: {
        network,
        storageDirPath: directory.replace(/^file:\/\//, ''),
        witnessVersion: 'taproot',
        reuseAddresses: true,
      },
      keys: new CallbackRgbLibKeyProvider(async () => {
        const mnemonic = await SecureStore.getItemAsync(key);
        if (!mnemonic) throw new Error('The saved RGB Lib wallet keys are unavailable.');
        return mnemonic;
      }),
    });
  }
  try {
    if (stoppedWallet) await wallet.reinit(config.unlockParams);
    else {
      await wallet.init();
      await wallet.unlock(config.unlockParams);
    }
    const identity = await wallet.getWalletIdentity();
    return {
      wallet,
      address: await wallet.getAddress(),
      account: `rgb:${network}:RGB-L1-${identity.id}`,
    };
  } catch (error) {
    pendingCleanup.set(network, wallet);
    try {
      await wallet.dispose();
      pendingCleanup.delete(network);
    } catch {
      throw new Error('RGB Lib could not close after opening failed. Retry Open wallet to finish cleanup.');
    }
    throw error;
  }
}
