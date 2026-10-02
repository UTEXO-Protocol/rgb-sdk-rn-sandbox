import { Core } from '@walletconnect/core';
import { WalletKit } from '@reown/walletkit';
import {
  createWalletConnectWallet,
  type WalletConnectWallet,
  type WalletConnectWalletContext,
  type WalletConnectBackend,
} from '@utexo/webrgb-walletconnect';
import { isRgbSession, parseWalletConnectUri, sessionOrigin } from './connection-protocol';
import type { DemoWalletState } from './types';
type WalletClient = Awaited<ReturnType<typeof WalletKit.init>>;
interface Host {
  network(): string;
  account(): string;
  methods(): readonly string[];
  enqueue<T>(action: () => Promise<T>): Promise<T>;
  confirm(
    title: string,
    origin: string,
    details: string,
    expiresAt: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  provider(context: WalletConnectWalletContext): WalletConnectBackend;
  set(state: Partial<DemoWalletState>): void;
}
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'Connection failed';
export class WalletConnection {
  private client?: WalletClient;
  private transport?: WalletConnectWallet;
  private core?: InstanceType<typeof Core>;
  private clientPromise?: Promise<WalletClient>;
  constructor(private readonly host: Host) {}
  async getClient(): Promise<WalletClient> {
    if (this.client) return this.client;
    if (this.clientPromise) return this.clientPromise;
    const projectId = process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim();
    if (!projectId || !/^[a-fA-F0-9]{32}$/.test(projectId))
      throw new Error('Set EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID and restart Metro.');
    // Keep the storage prefix stable so sessions survive app restarts.
    this.core ??= new Core({ projectId, customStoragePrefix: 'utexo-demo-wallet-webrgb-v2' });
    this.clientPromise = WalletKit.init({
      core: this.core,
      metadata: {
        name: 'UTEXO Demo Wallet',
        description: 'RGB wallet demo',
        url: 'https://utexo.com',
        icons: [],
        redirect: { native: 'myapp://wallet' },
      },
    })
      .then((client) => {
        const transport = createWalletConnectWallet({
          client,
          network: this.host.network(),
          account: this.host.account().slice(this.host.account().lastIndexOf(':') + 1),
          methods: [...this.host.methods()],
          approveSession: (proposal) =>
            this.host.enqueue(() =>
              this.host.confirm(
                'Connect to website?',
                proposal.origin,
                `${proposal.name}\nNetwork: ${proposal.network}\nPermissions: ${proposal.methods.join(', ')}\nWebsite verification: ${proposal.verification}\nInvoice creation, burn and proof sharing require confirmation.`,
                Date.now() + 240_000,
                proposal.signal,
              ),
            ),
          getProvider: (context) => this.host.provider(context),
          onSessionConnected: (session) => {
            this.refreshSessions();
            this.host.set({ message: `Connected to ${sessionOrigin(session.peer.metadata.url)}` });
          },
          onError: (error) => {
            console.warn('[Wallet] Connection/request delivery failed (see Wallet screen)');
            this.host.set({ error: messageOf(error) });
          },
        });
        this.client = client;
        this.transport = transport;
        client.on('session_delete', () => this.refreshSessions());
        client.core.expirer.on('expirer_expired', () => this.refreshSessions());
        this.refreshSessions();
        return client;
      })
      .finally(() => {
        this.clientPromise = undefined;
      });
    return this.clientPromise;
  }

  async pair(input: string) {
    const uri = parseWalletConnectUri(input);
    this.host.set({ error: '', message: 'Waiting for the website connection request…' });
    await this.getClient();
    await this.transport!.pair(uri);
  }

  private refreshSessions() {
    const sessions = Object.values(this.client?.getActiveSessions() ?? {}).filter((session) =>
      isRgbSession(
        session,
        this.host.account(),
        this.host.methods().map((method) => `rgb_${method}`),
      ),
    );
    this.host.set({ sessions });
  }

  async disconnect(topic: string) {
    await this.transport?.disconnect(topic);
    this.refreshSessions();
  }
}
