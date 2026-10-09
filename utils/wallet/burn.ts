import { encodeEvmBurnRecipient } from '@utexo/rgb-sdk-rn/webrgb';
import type { DemoWalletNetwork } from '../env';
import type { WalletAsset } from './types';

export const LOCAL_BURN_ORIGIN = 'local:wallet';

export type LocalBurnInput = {
  assetId: string;
  amount: string;
  payoutChainId: string;
  payoutAddress: string;
};

export function payoutChainLabel(chainId: string): string {
  if (chainId === 'eip155:1') return 'Ethereum';
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

export function prepareLocalBurn(input: LocalBurnInput, asset: WalletAsset | undefined, network: DemoWalletNetwork) {
  if (!asset || asset.assetId !== input.assetId || asset.schema !== 'BFA')
    throw new Error('Select a BFA asset held by this wallet.');
  if (!/^eip155:[1-9][0-9]*$/.test(input.payoutChainId))
    throw new Error('Enter a valid EVM payout chain ID.');
  const address = input.payoutAddress.trim();
  const recipient = encodeEvmBurnRecipient(address);
  const amount = burnBaseUnits(input.amount, asset.precision);
  assertBurnBalance(amount, asset.balance.spendable);
  return {
    params: {
      assetId: asset.assetId, amount, burnRecipient: recipient,
      // Same wallet defaults as the SDK WebRGB burn provider.
      feeRate: 2, minConfirmations: 3,
    },
    metadata: {
      origin: LOCAL_BURN_ORIGIN, network,
      payout: { chainId: input.payoutChainId, address: address.toLowerCase() },
    },
  };
}
