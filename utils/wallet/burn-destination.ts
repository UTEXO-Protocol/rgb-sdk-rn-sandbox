import { createBurnDestination } from '@utexo/rgb-sdk-rn/webrgb';
export const DEV_BURN_ROUTES = [
  { chainId: 'eip155:42161', dstEid: 0 },
  { chainId: 'eip155:1', dstEid: 30101 },
  { chainId: 'eip155:137', dstEid: 30109 },
  { chainId: 'eip155:9745', dstEid: 30383 },
  { chainId: 'tron:728126428', dstEid: 30420 },
] as const;
export function localBfaBurnDestination(payout: { chainId: string; address: string }) {
  return createBurnDestination(payout, DEV_BURN_ROUTES);
}
