import type { UTEXOWallet as RlnUtexoWallet } from '@utexo/rgb-sdk-rn';
import type { UTEXOWallet } from '@utexo/rgb-sdk';
import type { RgbLibWallet } from '@utexo/rgb-lib-rn';

/** RGB_L1: the @utexo/rgb-sdk facade over the @utexo/rgb-lib-rn engine. */
export type RgbLibUtexoWallet = UTEXOWallet<RgbLibWallet>;

/**
 * RGB_LN: still @utexo/rgb-sdk-rn. Its native module is not linked in this
 * build (see react-native.config.js), so RLN wallets cannot open here.
 */
export type RlnWallet = RlnUtexoWallet<'RGB_LN'>;

export type AnyUtexoWallet = RgbLibUtexoWallet | RlnWallet;

export const isRgbLibWallet = (wallet: AnyUtexoWallet): wallet is RgbLibUtexoWallet =>
  wallet.protocol === 'RGB_L1';
