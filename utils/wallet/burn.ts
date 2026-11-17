import { burnDestinationReason, normalizeBurnDestination, type AnyBurnOperationRecord, type BurnDestinationRoute } from '@utexo/rgb-sdk/webrgb';
import type { DemoWalletNetwork } from '../env';
import type { WalletAsset } from './types';

export const LOCAL_BURN_ORIGIN = 'local:wallet';

export type LocalBurnInput = {
  assetId: string;
  amount: string;
  payoutChainId: string;
  payoutAddress: string;
};

// Labels for CAIP-2 Tron chains; a burn still needs a configured route.
const TRON_CHAINS: Record<string, string> = {
  'tron:728126428': 'Tron',
  'tron:2494104990': 'Tron Shasta',
  'tron:3448148188': 'Tron Nile',
};

/** A bare number is an EVM chain ID; anything else must be a full CAIP-2 ID. */
export function payoutChainIdFromInput(value: string): string {
  const text = value.trim();
  return /^[0-9]+$/.test(text) ? `eip155:${text}` : text;
}

export function payoutChainLabel(chainId: string): string {
  if (TRON_CHAINS[chainId]) return TRON_CHAINS[chainId];
  if (chainId === 'eip155:1') return 'Ethereum';
  if (chainId === 'eip155:137') return 'Polygon';
  if (chainId === 'eip155:9745') return 'Plasma';
  if (chainId === 'eip155:42161') return 'Arbitrum One';
  if (chainId === 'eip155:31337') return 'Local EVM (31337)';
  return `EVM chain ${chainId.replace('eip155:', '')}`;
}

const validPrecision = (precision: number) =>
  Number.isInteger(precision) && precision >= 0 && precision <= 255;

/** Never round token input or pass a u64 through a JavaScript number. */
export function burnBaseUnits(value: string, precision: number): string {
  const text = value.trim();
  if (!validPrecision(precision) || !/^[0-9]+(?:\.[0-9]+)?$/.test(text) || text.length > 280)
    throw new Error('Enter a positive token amount using a decimal point.');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > precision)
    throw new Error(`This asset supports at most ${precision} decimal places.`);
  const amount = BigInt(whole + fraction.padEnd(precision, '0'));
  if (amount <= 0n || amount > 18446744073709551615n)
    throw new Error('Amount must be positive and within the supported token range.');
  return amount.toString();
}

export function formatBurnAmount(amount: string, precision: number): string {
  if (!validPrecision(precision) || !/^[0-9]+$/.test(amount)) return amount;
  if (!precision) return amount;
  const digits = amount.padStart(precision + 1, '0');
  const fraction = digits.slice(-precision).replace(/0+$/, '');
  return digits.slice(0, -precision) + (fraction ? `.${fraction}` : '');
}

export function burnMaxAmount(asset: WalletAsset): string | null {
  const balance = asset.balance.spendable;
  return Number.isSafeInteger(balance) && balance >= 0 && validPrecision(asset.precision)
    ? formatBurnAmount(String(balance), asset.precision) : null;
}

export function assertBurnBalance(amount: string, available: number | undefined): void {
  if (typeof available !== 'number' || !Number.isSafeInteger(available) || available < 0)
    throw new Error('The wallet returned an unsupported available balance. Refresh before burning.');
  if (BigInt(amount) > BigInt(available))
    throw new Error('Amount exceeds the available asset balance.');
}

/** The configured endpoint for a chain; the wallet owns routes, the form names only the chain. */
export function burnRouteFor(chainId: string, destinationRoutes: readonly BurnDestinationRoute[] | undefined): BurnDestinationRoute {
  if (!destinationRoutes?.length) throw new Error('Burn has no payout routes on this network.');
  const routes = destinationRoutes.filter((route) => route.chainId === chainId);
  if (!routes.length) throw new Error('This wallet has no payout route for that chain.');
  if (routes.length > 1) throw new Error('This chain has several payout endpoints; the demo supports one per chain.');
  return routes[0];
}

/** The payout of a journal record, whether it was saved by this release or an earlier one. */
export function burnPayout(record: AnyBurnOperationRecord): { chainId: string; address: string; dstEid?: number } {
  if (record.version === 3) return record.metadata.burnDestination;
  const { payout, burnDestination } = record.metadata;
  return burnDestination ? { ...payout, dstEid: burnDestination.dstEid } : payout;
}

export function prepareLocalBurn(input: LocalBurnInput, asset: WalletAsset | undefined, network: DemoWalletNetwork, destinationRoutes?: readonly BurnDestinationRoute[]) {
  if (!asset || asset.assetId !== input.assetId || asset.schema !== 'BFA')
    throw new Error('Select a BFA asset held by this wallet.');
  const { dstEid } = burnRouteFor(input.payoutChainId, destinationRoutes);
  let burnDestination;
  try {
    // Addresses stay as entered: Tron Base58Check and EVM checksums are case-sensitive.
    burnDestination = normalizeBurnDestination({ chainId: input.payoutChainId, address: input.payoutAddress.trim(), dstEid });
  } catch {
    throw new Error(input.payoutChainId.startsWith('tron:')
      ? 'Enter a valid Tron address (T…).'
      : 'Enter a valid EVM address (0x…).');
  }
  const amount = burnBaseUnits(input.amount, asset.precision);
  assertBurnBalance(amount, asset.balance.spendable);
  return {
    params: {
      assetId: asset.assetId, amount, burnRecipient: burnDestinationReason(burnDestination),
      // Same wallet defaults as the SDK WebRGB burn provider.
      feeRate: 2, minConfirmations: 3,
    },
    metadata: { origin: LOCAL_BURN_ORIGIN, network, burnDestination },
  };
}
