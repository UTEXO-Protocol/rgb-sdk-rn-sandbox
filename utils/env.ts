import type { IRLNUnlockParams } from '@utexo/rgb-sdk-rn';
import { Platform } from 'react-native';

export function readEnv(name: string): string | null {
  const value =
    (name === 'RLN_NODE_PASSWORD'
      ? process.env.EXPO_PUBLIC_RLN_NODE_PASSWORD
      : name === 'RLN_BITCOIND_RPC_USERNAME'
        ? process.env.EXPO_PUBLIC_RLN_BITCOIND_RPC_USERNAME
        : name === 'RLN_BITCOIND_RPC_PASSWORD'
          ? process.env.EXPO_PUBLIC_RLN_BITCOIND_RPC_PASSWORD
          : name === 'RLN_BITCOIND_RPC_HOST'
            ? process.env.EXPO_PUBLIC_RLN_BITCOIND_RPC_HOST
            : name === 'RLN_BITCOIND_RPC_PORT'
              ? process.env.EXPO_PUBLIC_RLN_BITCOIND_RPC_PORT
              : name === 'RLN_INDEXER_URL'
                ? process.env.EXPO_PUBLIC_RLN_INDEXER_URL
                : name === 'RLN_PROXY_ENDPOINT'
                  ? process.env.EXPO_PUBLIC_RLN_PROXY_ENDPOINT
                  : name === 'RLN_ANNOUNCE_ADDRESSES'
                    ? process.env.EXPO_PUBLIC_RLN_ANNOUNCE_ADDRESSES
                    : name === 'RLN_ANNOUNCE_ALIAS'
                      ? process.env.EXPO_PUBLIC_RLN_ANNOUNCE_ALIAS
                      : name === 'RLN_PLAYGROUND_NETWORK'
                        ? process.env.EXPO_PUBLIC_RLN_PLAYGROUND_NETWORK
                      : name === 'RLN_STRICT_UNLOCK_CREDS'
                        ? process.env.EXPO_PUBLIC_RLN_STRICT_UNLOCK_CREDS
                      : name === 'RLN_VSS_URL'
                        ? process.env.EXPO_PUBLIC_RLN_VSS_URL
                      : name === 'RLN_GOSSIP_RGS_URL'
                        ? process.env.EXPO_PUBLIC_RLN_GOSSIP_RGS_URL
                      : null) ?? null;
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

export function buildUtexoConfig() {
  const network = (process.env.EXPO_PUBLIC_UTEXO_NETWORK?.trim() || 'utexo') as any;
  const indexerUrl = process.env.EXPO_PUBLIC_UTEXO_INDEXER_URL?.trim() || 'https://dev.esplora-01.mint.utexo.com';
  const proxyEndpoint = process.env.EXPO_PUBLIC_UTEXO_PROXY_ENDPOINT?.trim() || 'rpcs://rgb-proxy.utexo.com/json-rpc';
  const gossipRgsServerUrl = process.env.EXPO_PUBLIC_UTEXO_GOSSIP_RGS_URL?.trim() || null;

  return {
    network,
    unlockParams: {
      ethRpcUrl: process.env.EXPO_PUBLIC_UTEXO_ETH_RPC_URL?.trim() || null,
      indexerUrl,
      proxyEndpoint,
      announceAddresses: [] as string[],
      announceAlias: null as string | null,
      // gossipRgsServerUrl,
    } as IRLNUnlockParams,
  };
}

export const DEMO_WALLET_NETWORKS = [
  { id: 'utexo', label: 'Utexo signet', short: 'Utexo', hint: 'signet' },
  { id: 'signet', label: 'Public signet', short: 'Signet', hint: 'public' },
  { id: 'regtest', label: 'Local regtest', short: 'Regtest', hint: 'local' },
  { id: 'mainnet', label: 'Mainnet', short: 'Mainnet', hint: 'real BTC' },
] as const;
export type DemoWalletNetwork = (typeof DEMO_WALLET_NETWORKS)[number]['id'];
export const isDemoWalletNetwork = (value: unknown): value is DemoWalletNetwork =>
  value === 'utexo' || value === 'signet' || value === 'regtest' || value === 'mainnet';

/** Public signet endpoints; the proxy implements protocol 1.0, so rgb-lib can use it too. */
export const PUBLIC_SIGNET_INDEXER_URL = 'ssl://electrum.iriswallet.com:50033';
export const PUBLIC_SIGNET_PROXY_ENDPOINT = 'rpcs://staging.rgb-proxy.utexo.com/json-rpc';

/** Mainnet endpoints, the same as the SDK defaults. */
export const MAINNET_INDEXER_URL = 'ssl://electrs-01.utexo.com:50002';
export const MAINNET_PROXY_ENDPOINT = 'rpcs://rgb-proxy.utexo.com/json-rpc';

export function buildSignetConfig() {
  return {
    network: 'signet' as const,
    unlockParams: {
      indexerUrl: process.env.EXPO_PUBLIC_SIGNET_INDEXER_URL?.trim() || PUBLIC_SIGNET_INDEXER_URL,
      proxyEndpoint: process.env.EXPO_PUBLIC_SIGNET_PROXY_ENDPOINT?.trim() || PUBLIC_SIGNET_PROXY_ENDPOINT,
      announceAddresses: [] as string[],
      announceAlias: null as string | null,
    } as IRLNUnlockParams,
  };
}

/** The Wallet tab selects its network explicitly; a mock URL only configures regtest. */
export function buildDemoWalletConfig(network: DemoWalletNetwork = 'utexo') {
  if (network === 'utexo') return { ...buildUtexoConfig(), network };
  if (network === 'signet') return buildSignetConfig();
  if (network === 'mainnet') return buildMainnetConfig();
  if (network !== 'regtest') throw new Error('Unsupported wallet network');
  const mockUrl = process.env.EXPO_PUBLIC_DEMO_MOCK_FAUCET_URL?.trim();
  if (!mockUrl) return buildRegtestConfig();
  const url = new URL(mockUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Use an HTTP URL for the local regtest mock faucet');
  return {
    network: 'regtest' as const,
    unlockParams: {
      indexerUrl: `${url.hostname}:51211`,
      proxyEndpoint: `rpc://${url.hostname}:31210/json-rpc`,
      ethRpcUrl: `${mockUrl.replace(/\/$/, '')}/rpc`,
      announceAddresses: [] as string[],
      announceAlias: null,
    } as IRLNUnlockParams,
  };
}

export function buildMainnetConfig() {
  const indexerUrl = process.env.EXPO_PUBLIC_MAINNET_INDEXER_URL?.trim() || MAINNET_INDEXER_URL;
  const proxyEndpoint = process.env.EXPO_PUBLIC_MAINNET_PROXY_ENDPOINT?.trim() || MAINNET_PROXY_ENDPOINT;

  return {
    network: 'mainnet' as const,
    unlockParams: {
      indexerUrl,
      proxyEndpoint,
      announceAddresses: [] as string[],
      announceAlias: null as string | null,
    } as IRLNUnlockParams,
  };
}

export function buildRegtestConfig() {
  const rpcHost = readEnv('RLN_BITCOIND_RPC_HOST');
  const rpcPort = readEnv('RLN_BITCOIND_RPC_PORT');
  const rpcUsername = readEnv('RLN_BITCOIND_RPC_USERNAME');
  const rpcPassword = readEnv('RLN_BITCOIND_RPC_PASSWORD');
  const defaultHost = Platform.OS === 'android' ? '10.0.2.2' : '127.0.0.1';
  const indexerUrl = readEnv('RLN_INDEXER_URL') ?? `${rpcHost ?? defaultHost}:50001`;
  const proxyEndpoint = readEnv('RLN_PROXY_ENDPOINT') ?? `rpc://${rpcHost ?? defaultHost}:3000/json-rpc`;

  return {
    network: 'regtest' as const,
    unlockParams: {
      // bitcoindRpcUsername: rpcUsername,
      // bitcoindRpcPassword: rpcPassword,
      // bitcoindRpcHost: rpcHost,
      // bitcoindRpcPort: rpcPort ? Number(rpcPort) : null,
      indexerUrl,
      proxyEndpoint,
      announceAddresses: [] as string[],
      announceAlias: null as string | null,
      // gossipRgsServerUrl: readEnv('RLN_GOSSIP_RGS_URL'),
    } as IRLNUnlockParams,
  };
}
