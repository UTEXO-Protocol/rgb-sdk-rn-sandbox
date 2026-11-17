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

/** The SDK's own signature when it has the method; older SDKs lack it at runtime too. */
type ProviderReceivedMint = WebRgbProvider extends { getReceivedMint: infer F }
  ? F
  : (args: { invoice: string }) => Promise<unknown>;

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
  // Apply the floor before SDK validation/approval so the user sees the actual expiry.
  const withMintWindow = (args: RgbBlindReceiveArgs = {}): RgbBlindReceiveArgs => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    const seconds = args.durationSeconds ?? MIN_INVOICE_DURATION_SECONDS;
    return {
      ...args,
      durationSeconds: typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0
        ? Math.max(seconds, MIN_INVOICE_DURATION_SECONDS)
        : seconds,
    };
  };
  // Present only in SDK releases with invoice-scoped mint validation.
  const getReceivedMint = (provider as { getReceivedMint?: ProviderReceivedMint })
    .getReceivedMint?.bind(provider);

  const backend: WalletConnectBackend = {
    enable: wrap('enable', () => provider.enable()),
    getInfo: wrap('getInfo', async () => {
      // Payout routes stay wallet-side (profiles.ts): the SDK checks every
      // burnDestination against them and does not advertise them.
      const info = await provider.getInfo();
      // List only what this backend serves: a listed method must not reject
      // with METHOD_NOT_SUPPORTED. createUtxos, getBtcBalance, refresh and
      // getAssetMetadata are not served yet: WalletConnect does not carry them.
      const methods = info.methods.filter(
        (method) => method in backend && (options.burnEnabled || !BURN_METHODS.has(method)),
      );
      return { ...info, methods };
    }),
    getAddress: wrap('getAddress', () => provider.getAddress()),
    blindReceive: wrap('blindReceive', (args?: RgbBlindReceiveArgs) =>
      provider.blindReceive(withMintWindow(args))),
    witnessReceive: wrap('witnessReceive', (args?: RgbBlindReceiveArgs) =>
      provider.witnessReceive(withMintWindow(args))),
    listAssets: wrap('listAssets', () => provider.listAssets()),
    getAssetBalance: wrap('getAssetBalance', provider.getAssetBalance.bind(provider)),
    listTransfers: wrap('listTransfers', provider.listTransfers.bind(provider)),
    getTransferStatus: wrap('getTransferStatus', provider.getTransferStatus.bind(provider)),
    decodeRgbInvoice: wrap('decodeRgbInvoice', provider.decodeRgbInvoice.bind(provider)),
    burnAsset: wrap('burnAsset', burnOnly(provider.burnAsset.bind(provider))),
    getConsignment: wrap('getConsignment', burnOnly(provider.getConsignment.bind(provider))),
    // No prompt: the SDK binds the result to an invoice this wallet created.
    ...(getReceivedMint && { getReceivedMint: wrap('getReceivedMint', getReceivedMint) }),
  };
  return backend;
}
