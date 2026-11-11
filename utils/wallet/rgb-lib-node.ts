import {
  CallbackRgbLibKeyProvider,
  generateKeys,
  RgbLibWallet,
  DEFAULT_EVM_MINT_LOCK_BLOCKS,
  type RgbLibMintLockBlocks,
  type RgbLibUnlockParams,
} from '@utexo/rgb-sdk-rn';
import { UTEXOWallet } from '@utexo/rgb-sdk';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import type { RgbLibUtexoWallet } from './wallets';
import {
  MAINNET_INDEXER_URL,
  MAINNET_PROXY_ENDPOINT,
  PUBLIC_SIGNET_INDEXER_URL,
  PUBLIC_SIGNET_PROXY_ENDPOINT,
  type DemoWalletNetwork,
} from '../env';

// Expo inlines EXPO_PUBLIC_* only on static access, so each variable is named in full.
function rgbLibEnv(network: DemoWalletNetwork) {
  switch (network) {
    case 'utexo':
      return {
        indexerUrl: process.env.EXPO_PUBLIC_RGB_LIB_UTEXO_INDEXER_URL,
        proxyEndpoint: process.env.EXPO_PUBLIC_RGB_LIB_UTEXO_PROXY_ENDPOINT,
        evmJson: process.env.EXPO_PUBLIC_RGB_LIB_UTEXO_EVM_RPC_URLS,
        lockJson: process.env.EXPO_PUBLIC_RGB_LIB_UTEXO_EVM_MINT_LOCK_BLOCKS,
      };
    case 'signet':
      return {
        indexerUrl: process.env.EXPO_PUBLIC_RGB_LIB_SIGNET_INDEXER_URL?.trim() || PUBLIC_SIGNET_INDEXER_URL,
        proxyEndpoint: process.env.EXPO_PUBLIC_RGB_LIB_SIGNET_PROXY_ENDPOINT?.trim() || PUBLIC_SIGNET_PROXY_ENDPOINT,
        evmJson: process.env.EXPO_PUBLIC_RGB_LIB_SIGNET_EVM_RPC_URLS,
        lockJson: process.env.EXPO_PUBLIC_RGB_LIB_SIGNET_EVM_MINT_LOCK_BLOCKS,
      };
    case 'mainnet':
      return {
        indexerUrl: process.env.EXPO_PUBLIC_RGB_LIB_MAINNET_INDEXER_URL?.trim() || MAINNET_INDEXER_URL,
        proxyEndpoint: process.env.EXPO_PUBLIC_RGB_LIB_MAINNET_PROXY_ENDPOINT?.trim() || MAINNET_PROXY_ENDPOINT,
        evmJson: process.env.EXPO_PUBLIC_RGB_LIB_MAINNET_EVM_RPC_URLS,
        lockJson: process.env.EXPO_PUBLIC_RGB_LIB_MAINNET_EVM_MINT_LOCK_BLOCKS,
      };
    case 'regtest':
      return {
        indexerUrl: process.env.EXPO_PUBLIC_RGB_LIB_REGTEST_INDEXER_URL,
        proxyEndpoint: process.env.EXPO_PUBLIC_RGB_LIB_REGTEST_PROXY_ENDPOINT,
        evmJson: process.env.EXPO_PUBLIC_RGB_LIB_REGTEST_EVM_RPC_URLS,
        lockJson: process.env.EXPO_PUBLIC_RGB_LIB_REGTEST_EVM_MINT_LOCK_BLOCKS,
      };
  }
}

/** No implicit reuse of an RLN deployment: the two releases need compatible proxies. */
export function buildRgbLibConfig(network: DemoWalletNetwork) {
  const env = rgbLibEnv(network);
  const indexerUrl = env.indexerUrl?.trim();
  const proxyEndpoint = env.proxyEndpoint?.trim();
  const evmJson = env.evmJson?.trim();
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
  // Optional: a chain without bounds uses the SDK default (DEFAULT_EVM_MINT_LOCK_BLOCKS).
  const lockJson = env.lockJson?.trim();
  let evmMintLockBlocks: Record<string, RgbLibMintLockBlocks> | undefined;
  if (lockJson) {
    const blocks = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    try {
      const parsed: unknown = JSON.parse(lockJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        !Object.entries(parsed).every(([chain, value]) => {
          const entry = value as Partial<Record<keyof RgbLibMintLockBlocks, unknown>> | null;
          return /^[1-9][0-9]*$/.test(chain) && !!entry && typeof entry === 'object' &&
            blocks(entry.min) && blocks(entry.max) && (entry.min as number) <= (entry.max as number);
        })) throw new Error();
      evmMintLockBlocks = parsed as Record<string, RgbLibMintLockBlocks>;
    } catch {
      throw new Error(`${prefix}_EVM_MINT_LOCK_BLOCKS must be a JSON object mapping EVM chain IDs to { min, max } block counts with min <= max.`);
    }
    const orphan = Object.keys(evmMintLockBlocks).find((chain) => !evmRpcUrls?.[chain]);
    if (orphan) throw new Error(`${prefix}_EVM_MINT_LOCK_BLOCKS sets chain ${orphan}, which has no entry in ${prefix}_EVM_RPC_URLS.`);
  }
  return { network, unlockParams: { indexerUrl, proxyEndpoint, evmRpcUrls, evmMintLockBlocks } satisfies RgbLibUnlockParams };
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
    `EVM chains: ${Object.keys(unlockParams.evmRpcUrls ?? {}).map((id) => {
      const lock = unlockParams.evmMintLockBlocks?.[id] ?? DEFAULT_EVM_MINT_LOCK_BLOCKS;
      return `${id} (mint lock ${lock.min}–${lock.max} blocks${unlockParams.evmMintLockBlocks?.[id] ? '' : ', default'})`;
    }).join(', ') || 'Not configured'}`,
    'Witness: taproot',
    `Storage: ${storageDirectory(network).replace(/^file:\/\//, '')}`,
  ].join('\n');
}

// A failed native cleanup still owns the directory; retain it until cleanup succeeds.
const pendingCleanup = new Map<DemoWalletNetwork, RgbLibUtexoWallet>();

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

export async function openSavedRgbLibWallet(network: DemoWalletNetwork, stoppedWallet?: RgbLibUtexoWallet) {
  const key = credentialsKey(network);
  if (await SecureStore.getItemAsync(`${key}-deleting`)) {
    throw new Error('Wallet deletion is incomplete. Retry Delete wallet before opening a new wallet.');
  }
  const config = buildRgbLibConfig(network);
  await closePendingWallet(network);
  let wallet = stoppedWallet;
  if (!wallet) {
    if (!(await SecureStore.getItemAsync(key))) {
      const { mnemonic } = await generateKeys(network);
      // Persist before native state is created, including on a failed first open.
      await SecureStore.setItemAsync(key, mnemonic);
    }
    const directory = storageDirectory(network);
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    // Same storage directory, keys and params as @utexo/rgb-sdk-rn beta.40:
    // wallets created by the earlier demo open unchanged.
    const engine = new RgbLibWallet(
      {
        network,
        storageDirPath: directory.replace(/^file:\/\//, ''),
        witnessVersion: 'taproot',
        reuseAddresses: true,
        // Endpoints given once. rgb-lib connects (goOnline) lazily with them on
        // the first online operation, once per session.
        ...config.unlockParams,
      },
      new CallbackRgbLibKeyProvider(async () => {
        const mnemonic = await SecureStore.getItemAsync(key);
        if (!mnemonic) throw new Error('The saved RGB Lib wallet keys are unavailable.');
        return mnemonic;
      }),
    );
    wallet = new UTEXOWallet({ engine });
  }
  try {
    // No explicit connect: the first online read (balances) runs goOnline.
    if (stoppedWallet) await wallet.reinit();
    else await wallet.init();
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
