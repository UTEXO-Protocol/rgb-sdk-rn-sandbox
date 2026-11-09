import type { RgbLibUnlockParams } from '@utexo/rgb-sdk-rn';
export type DemoWalletNetwork = 'utexo' | 'regtest';
export const DEMO_WALLET_NETWORKS = [{ id: 'utexo' as const, label: 'New Dev · RGB v6' }];
export const isDemoWalletNetwork = (value: unknown): value is DemoWalletNetwork => value === 'utexo';
export function buildDemoWalletConfig(network: DemoWalletNetwork = 'utexo') {
  if (network !== 'utexo') throw new Error('This app is configured for the new Dev environment.');
  return {
    network,
    unlockParams: {
      indexer: { type: 'esplora' as const, url: process.env.EXPO_PUBLIC_UTEXO_INDEXER_URL?.trim() || 'https://dev.esplora-01.mint.utexo.com' },
      proxyEndpoint: process.env.EXPO_PUBLIC_UTEXO_PROXY_ENDPOINT?.trim() || 'rpcs://dev.rgb-proxy.utexo.com/json-rpc',
      // Receiver accepts mint locks up to two hours ahead on Arbitrum.
      // The native mint API (not exposed by this app) uses a five-minute minimum.
      evmMintLockBlocks: { '42161': { min: 1200, max: 28800 } },
      evmRpcUrls: { '42161': process.env.EXPO_PUBLIC_UTEXO_ETH_RPC_URL?.trim() || 'https://arb1.arbitrum.io/rpc' },
    } satisfies RgbLibUnlockParams,
  };
}
