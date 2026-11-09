import { WebRgbError, WebRgbProvider, type WebRgbOptions } from '@utexo/rgb-sdk/webrgb';
import type { AnyUtexoWallet } from './wallets';
import type { WalletConnectBackend, WalletConnectWalletContext } from '@utexo/webrgb-walletconnect';
import type { RgbBlindReceiveArgs } from '@utexo/webrgb';
import { MIN_INVOICE_DURATION_SECONDS } from './invoice';

export interface DemoProviderOptions {
  context: WalletConnectWalletContext;
  burn: WebRgbOptions['burn'];
  /** Demo policy: burn only on networks with bridge routes (see profiles.ts). */
  burnEnabled: boolean;
  confirm: WebRgbOptions['confirm'];
  run<T>(method: string, args: unknown[], action: () => Promise<T>): Promise<T>;
}

/** The SDK supplies WebRGB results; the demo adds its operation queue and UI. */
export function createDemoRgbProvider(
  wallet: AnyUtexoWallet,
  options: DemoProviderOptions,
): WalletConnectBackend {
  const { context } = options;
  const provider = new WebRgbProvider(wallet, {
    origin: context.origin,
    sessionApproved: true,
    assertAuthorized: () => context.assertAuthorized(),
    burn: options.burn,
    confirm: options.confirm,
  });
  context.signal.addEventListener('abort', () => provider.revoke(), { once: true });
  const wrap =
    <A extends unknown[], R>(method: string, action: (...args: A) => Promise<R>) =>
    (...args: A) =>
      options.run(method, args, () => action(...args));

  const burnOnly =
    <A extends unknown[], R>(action: (...args: A) => Promise<R>) =>
    (...args: A) =>
      options.burnEnabled
        ? action(...args)
        : Promise.reject(new WebRgbError('METHOD_NOT_SUPPORTED', 'Burn is off on this network'));
  const BURN_METHODS = new Set(['burnAsset', 'getConsignment']);

  return {
    enable: wrap('enable', () => provider.enable()),
    getInfo: wrap('getInfo', async () => {
      const info = await provider.getInfo();
      return options.burnEnabled
        ? info
        : { ...info, methods: info.methods.filter((method) => !BURN_METHODS.has(method)) };
    }),
    getAddress: wrap('getAddress', () => provider.getAddress()),
    blindReceive: wrap('blindReceive', (args: RgbBlindReceiveArgs = {}) => {
      // Apply the floor before SDK validation/approval so the user sees the actual expiry.
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        const seconds = args.durationSeconds ?? MIN_INVOICE_DURATION_SECONDS;
        args = {
          ...args,
          durationSeconds: typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0
            ? Math.max(seconds, MIN_INVOICE_DURATION_SECONDS)
            : seconds,
        };
      }
      return provider.blindReceive(args);
    }),
    listAssets: wrap('listAssets', () => provider.listAssets()),
    getAssetBalance: wrap('getAssetBalance', provider.getAssetBalance.bind(provider)),
    listTransfers: wrap('listTransfers', provider.listTransfers.bind(provider)),
    getTransferStatus: wrap('getTransferStatus', provider.getTransferStatus.bind(provider)),
    decodeRgbInvoice: wrap('decodeRgbInvoice', provider.decodeRgbInvoice.bind(provider)),
    burnAsset: wrap('burnAsset', burnOnly(provider.burnAsset.bind(provider))),
    getConsignment: wrap('getConsignment', burnOnly(provider.getConsignment.bind(provider))),
  };
}
