import type { UTEXOWallet as RlnUtexoWallet } from '@utexo/rgb-sdk-rn-rln';
import type { UTEXOWallet } from '@utexo/rgb-sdk';
import type { RgbLibRn } from '@utexo/rgb-sdk-rn';

/** RGB_L1: the @utexo/rgb-sdk facade over the @utexo/rgb-sdk-rn engine. */
export type RgbLibUtexoWallet = UTEXOWallet<RgbLibRn>;

/**
 * RGB_LN: still the published RLN package (alias @utexo/rgb-sdk-rn-rln). Its native module is not linked in this
 * build (see react-native.config.js), so RLN wallets cannot open here.
 */
export type RlnWallet = RlnUtexoWallet<'RGB_LN'>;

export type AnyUtexoWallet = RgbLibUtexoWallet | RlnWallet;

export const isRgbLibWallet = (wallet: AnyUtexoWallet): wallet is RgbLibUtexoWallet =>
  wallet.protocol === 'RGB_L1';
