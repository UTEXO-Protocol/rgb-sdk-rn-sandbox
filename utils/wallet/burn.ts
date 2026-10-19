import { encodeEvmBurnRecipient, encodeTronBurnRecipient } from '@utexo/rgb-sdk-rn/webrgb';
import type { DemoWalletNetwork } from '../env';
import type { WalletAsset } from './types';
import { localBfaBurnDestination } from '@utexo/rgb-sdk-rn';

export const LOCAL_BURN_ORIGIN = 'local:wallet';

export type LocalBurnInput = {
  assetId: string;
  amount: string;
  payoutChainId: string;
  payoutAddress: string;
};

// CAIP-2 Tron chains accepted by the SDK burn recipient validator.
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
  if (chainId === 'eip155:42161') return 'Arbitrum One';
  if (chainId === 'eip155:137') return 'Polygon';
  if (chainId === 'eip155:9745') return 'Plasma';
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
  const address = input.payoutAddress.trim();
  let recipient: string;
  let payoutAddress: string;
  if (/^eip155:[1-9][0-9]*$/.test(input.payoutChainId)) {
    recipient = encodeEvmBurnRecipient(address);
    payoutAddress = address.toLowerCase();
  } else if (TRON_CHAINS[input.payoutChainId]) {
    recipient = encodeTronBurnRecipient(address);
    // Base58Check is case-sensitive; keep the address exactly as entered.
    payoutAddress = address;
  } else {
    throw new Error('Enter an EVM chain ID or a supported Tron chain.');
  }
  localBfaBurnDestination({ chainId: input.payoutChainId, address: payoutAddress });
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
      payout: { chainId: input.payoutChainId, address: payoutAddress },
    },
  };
}
