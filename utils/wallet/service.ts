import AsyncStorage from '@react-native-async-storage/async-storage';
import { BurnOperations, type UTEXOWallet } from '@utexo/rgb-sdk-rn';
import { WEBRGB_READ_METHODS, type WebRgbApproval } from '@utexo/rgb-sdk-rn/webrgb';
import type { WalletConnectWalletContext } from '@utexo/webrgb-walletconnect';
import { buildDemoWalletConfig } from '../env';
import { mockFaucetEnabled, mockFaucetRequest } from '../mock-faucet';
import { createDemoRgbProvider } from './provider';
import { WalletConnection } from './connection';
import { openSavedWallet } from './node';
import { createBurnStore } from './storage';
import type { DemoWalletState, WalletAsset } from './types';

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'Wallet operation failed';

class DemoWalletService {
  private state: DemoWalletState = {
    ready: false,
    busy: false,
    address: '',
    network: 'utexo',
    sessions: [],
    prompt: null,
    error: '',
    message: '',
    invoice: null,
    btcBalance: null,
    assets: [],
    transfers: [],
    updatedAt: null,
    refreshing: false,
    activeRequest: '',
    lastRequest: null,
    burnAvailable: false,
    burns: [],
  };
  private listeners = new Set<() => void>();
  private wallet?: UTEXOWallet;
  private queue: Promise<unknown> = Promise.resolve();
  private account = '';
  private readonly burnStore = createBurnStore(
    () => this.account,
    (burns) => this.set({ burns }),
  );
  private operations?: BurnOperations;
  readonly connection = new WalletConnection({
    network: () => this.state.network,
    account: () => this.account,
    methods: () => this.supportedMethods(),
    enqueue: (action) => this.enqueue(action),
    confirm: (...args) => this.confirm(...args),
    provider: (context) => this.provider(context),
    set: (patch) => this.set(patch),
  });
  private supportedMethods(): readonly string[] {
    return this.state.burnAvailable
      ? [...WEBRGB_READ_METHODS, 'burnAsset', 'getConsignment']
      : WEBRGB_READ_METHODS;
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<DemoWalletState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  clearError() {
    this.set({ error: '' });
  }

  private confirm(
    title: string,
    origin: string,
    details: string,
    expiresAt = Date.now() + 240_000,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (value: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        this.set({ prompt: null });
        resolve(value && Date.now() < expiresAt);
      };
      const aborted = () => finish(false);
      const timer = setTimeout(() => finish(false), Math.max(0, expiresAt - Date.now()));
      this.set({
        prompt: { title, origin, details, expiresAt, resolve: finish },
      });
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) finish(false);
    });
  }

  async start() {
    if (this.state.ready || this.state.busy) return;
    this.set({ busy: true, error: '', message: 'Opening wallet…' });
    console.info('[Wallet] Opening saved wallet');
    let wallet: UTEXOWallet | undefined;
    try {
      const config = buildDemoWalletConfig();
      const opened = await openSavedWallet(config);
      wallet = opened.wallet;
      const { address } = opened;
      this.account = opened.account;
      this.operations = new BurnOperations(wallet, this.burnStore);
      await this.operations.retryPersistence();
      this.wallet = wallet;
      const capabilities = await wallet.getBfaCapabilities();
      this.set({
        burnAvailable:
          capabilities.burn && capabilities.consignment && !!config.unlockParams.ethRpcUrl,
        burns: await this.burnStore.readAll(),
      });
      this.set({
        ready: true,
        network: config.network,
        address,
        message: 'Wallet ready. Fund the address, then prepare receive UTXOs.',
      });
      await this.readWalletData().catch((error) => {
        this.set({ error: `Wallet opened; balances could not load: ${messageOf(error)}` });
      });
      console.info('[Wallet] Wallet ready');
      const projectId = process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();
      if (projectId) await this.connection.getClient();
    } catch (error) {
      if (!this.state.ready) await wallet?.dispose().catch(() => undefined);
      this.set({ error: messageOf(error), message: '' });
    } finally {
      this.set({ busy: false });
    }
  }

  /** Publish a consistent snapshot only after all native reads succeed. */
  private async readWalletData() {
    const wallet = this.wallet!;
    // Native calls share the same RLN wallet; keep them sequential.
    const btcBalance = await wallet.getBtcBalance();
    const groups = await wallet.listAssets();
    const assets: WalletAsset[] = Object.entries(groups).flatMap(([schema, group]) =>
      (group ?? []).map((asset) => ({
        assetId: asset.assetId,
        name: asset.name,
        ticker: 'ticker' in asset ? asset.ticker : undefined,
        schema: schema.toUpperCase(),
        precision: asset.precision,
        balance: asset.balance,
      })),
    );
    const transfers: DemoWalletState['transfers'] = [];
    // RLN requires asset_id or txid; unlike rgb-lib it cannot list every transfer at once.
    for (const asset of assets) {
      transfers.push(
        ...(await wallet.listTransfers(asset.assetId)).map((transfer) => ({
          ...transfer,
          assetId: asset.assetId,
        })),
      );
    }
    const burns = await this.burnStore.readAll();
    this.set({
      btcBalance,
      assets,
      burns,
      transfers: [...transfers].sort((a, b) => b.createdAt - a.createdAt || b.idx - a.idx),
      updatedAt: Date.now(),
    });
  }

  /** Local actions use the same queue as dApp requests, so native work cannot overlap. */
  private async localAction(label: string, action: (wallet: UTEXOWallet) => Promise<void>) {
    if (
      !this.wallet ||
      !this.state.ready ||
      this.state.busy ||
      this.state.prompt ||
      this.state.activeRequest
    )
      return;
    this.set({ busy: true, error: '', message: `${label}…` });
    const operation = this.queue.then(async () => {
      console.info(`[Wallet] ${label}: started`);
      await action(this.wallet!);
      console.info(`[Wallet] ${label}: completed`);
    });
    this.queue = operation.catch(() => undefined);
    try {
      await operation;
    } catch (error) {
      console.warn(`[Wallet] ${label}: failed (see Wallet screen)`);
      this.set({ error: messageOf(error), message: '' });
    } finally {
      this.set({ busy: false, refreshing: false });
    }
  }

  async refresh() {
    return this.localAction('Refresh wallet', async (wallet) => {
      this.set({ refreshing: true });
      await this.operations?.retryPersistence();
      await wallet.refreshWallet();
      await this.readWalletData();
      this.set({ message: 'Balances and transfers updated.' });
    });
  }

  async generateInvoice(input: { amount: string; assetId?: string; durationMinutes: string }) {
    return this.localAction('Create receive invoice', async (wallet) => {
      const amountText = input.amount.trim();
      const amount = amountText ? Number(amountText) : undefined;
      if (amountText && (!/^[1-9][0-9]*$/.test(amountText) || !Number.isSafeInteger(amount)))
        throw new Error('Enter a positive whole amount in base units, or leave it empty.');
      const minutes = Number(input.durationMinutes);
      if (
        !/^[1-9][0-9]*$/.test(input.durationMinutes) ||
        !Number.isSafeInteger(minutes) ||
        minutes > 43200
      )
        throw new Error('Invoice expiry must be between 1 and 43,200 minutes.');
      const assetId = input.assetId || undefined;
      const asset = this.state.assets.find((item) => item.assetId === assetId);
      if (assetId && !asset)
        throw new Error('Select an asset in this wallet, or choose Any / new asset.');
      // The current BFA build rejects Fungible(amount) with a BFA schema in receive.
      // Never silently drop the user's requested asset or amount.
      if (asset?.schema === 'BFA' && amount !== undefined)
        throw new Error(
          'This BFA build requires an open amount. Leave amount empty, or select Any / new asset to request a fixed amount.',
        );
      const result = await wallet.blindReceive({
        assetId,
        amount,
        durationSeconds: minutes * 60,
        minConfirmations: 3,
      });
      // Keep the generated invoice even if the subsequent balance read fails.
      this.set({
        invoice: { ...result, assetId, amount, source: 'Created on this device' },
        message: 'Invoice ready. Copy or share it with the sender.',
      });
      await this.readWalletData().catch((error) => {
        this.set({ error: `Invoice created; balances could not refresh: ${messageOf(error)}` });
      });
    });
  }

  async prepareReceive() {
    return this.localAction('Prepare receive UTXOs', async (wallet) => {
      await wallet.createUtxos({
        upTo: true,
        num: 4,
        size: 1000,
        feeRate: 2,
      });
      await this.readWalletData();
      this.set({
        message:
          'Receive UTXOs prepared. Wait for their transaction to confirm before requesting an invoice.',
      });
    });
  }

  async mockFundOrMine(action: 'fund' | 'mine') {
    if (!mockFaucetEnabled(this.state.network)) return;
    return this.localAction(
      action === 'fund' ? 'Get test BTC' : 'Mine 3 blocks',
      async (wallet) => {
        if (action === 'fund') {
          const key = `mock-funding-v1:${this.account}`;
          let requestId = await AsyncStorage.getItem(key);
          if (!requestId) {
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            requestId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
            await AsyncStorage.setItem(key, requestId);
          }
          await mockFaucetRequest('/fund', { requestId, address: this.state.address });
          this.set({
            message: '100,000 regtest sats funded. Prepare receive UTXOs, then mine 3 blocks.',
          });
        } else {
          await mockFaucetRequest('/mine', { blocks: 3 });
          this.set({
            message: 'Mined 3 regtest blocks. Allow a few seconds for the indexer to sync.',
          });
        }
        await wallet.refreshWallet();
        await this.readWalletData();
      },
    );
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async pair(input: string) {
    if (!this.state.ready) throw new Error('Open your wallet first.');
    return this.connection.pair(input);
  }
  async disconnect(topic: string) {
    return this.connection.disconnect(topic);
  }

  private provider(context: WalletConnectWalletContext) {
    if (!this.wallet) throw new Error('Wallet is not ready');
    return createDemoRgbProvider(this.wallet, {
      context,
      burn: this.state.burnAvailable
        ? {
            operations: this.operations!,
            allowedPayoutChainIds: (
              process.env.EXPO_PUBLIC_DEMO_PAYOUT_CHAIN_IDS ||
              (mockFaucetEnabled(this.state.network) ? 'eip155:31337' : 'eip155:42161')
            )
              .split(',')
              .map((value) => value.trim()),
          }
        : undefined,
      confirm: (request: WebRgbApproval) => {
        const isBurn = request.method === 'burnAsset';
        const isProof = request.method === 'getConsignment';
        const recipient = request.params.burnRecipient as
          | { chainId: string; address: string }
          | undefined;
        const details = isBurn
          ? `Asset: ${request.params.assetId}\nAmount: ${request.params.amount} base units\nRGB network: ${this.state.network}\nPayout network: ${recipient?.chainId}\nPayout address: ${recipient?.address}\nBTC fee rate: ${request.params.feeRate} sat/vB\nConfirmations: ${request.params.minConfirmations}\nThis permanently burns tokens and allows this website to receive the burn proof.`
          : isProof
            ? `Share the burn proof and its asset history with this website?\nAsset: ${request.params.assetId}\nTransaction: ${request.params.txid}`
            : `Asset: ${request.params.assetId ?? 'Any asset (including a new asset)'}\nAmount: ${request.params.amount ?? 'Any amount'} base units\nNetwork: ${this.state.network}\nConfirmations: ${request.params.minConfirmations}\nExpires in: ${request.params.durationSeconds} seconds`;
        return this.confirm(
          isBurn ? 'Burn tokens?' : isProof ? 'Share burn proof?' : 'Create RGB receive invoice?',
          request.origin,
          details,
          Date.now() + 240_000,
          context.requestSignal,
        );
      },
      run: (method, args, action) =>
        this.enqueue(async () => {
          const wireMethod = `rgb_${method}`;
          const noteworthy = ['blindReceive', 'burnAsset', 'getConsignment'].includes(method);
          this.set({ activeRequest: wireMethod });
          try {
            context.assertAuthorized();
            if (noteworthy) console.info(`[Wallet] ${method}: awaiting approval/execution`);
            const result = await action();
            if (method === 'blindReceive') {
              const invoice = result as { invoice: string; expirationTimestamp?: number };
              const receive = args[0] as { assetId?: string; amount?: number } | undefined;
              this.set({
                invoice: { ...invoice, ...receive, source: `Sent to ${context.origin}` },
                message: 'Invoice created for Mint UI.',
              });
            }
            if (noteworthy) {
              this.set({ lastRequest: { method: wireMethod, status: 'completed' } });
              console.info(`[Wallet] ${method}: completed; returning result`);
            }
            if (['blindReceive', 'burnAsset', 'getTransferStatus'].includes(method)) {
              await this.readWalletData().catch((error) => {
                this.set({
                  error: `Operation completed; balances could not refresh: ${messageOf(error)}`,
                });
              });
            }
            return result;
          } catch (error) {
            this.set({
              lastRequest: { method: wireMethod, status: 'failed', error: messageOf(error) },
            });
            console.warn(`[Wallet] ${method}: failed (see Wallet screen)`);
            throw error;
          } finally {
            this.set({ activeRequest: '' });
          }
        }),
    });
  }
}

// Fast Refresh can evaluate this module again without resetting Hermes.
// Preserve the wallet, Core and listeners together until a full app reload.
const runtime = globalThis as typeof globalThis & {
  __utexoDemoWallet?: DemoWalletService;
};
export const demoWallet = (runtime.__utexoDemoWallet ??= new DemoWalletService());
