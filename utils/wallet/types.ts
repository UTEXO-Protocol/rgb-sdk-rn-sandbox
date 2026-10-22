import type { AnyUtexoWallet, BurnOperationRecord, WalletProtocol, WalletTransfer } from '@utexo/rgb-sdk-rn';
import type { DemoWalletNetwork } from '../env';
import type { WalletConnectSession } from '@utexo/webrgb-walletconnect';

export type WalletPrompt = {
  title: string;
  origin: string;
  details: string;
  expiresAt: number;
  resolve: (approved: boolean) => void;
};
export type DemoWalletState = {
  protocol: WalletProtocol;
  ready: boolean;
  busy: boolean;
  address: string;
  network: DemoWalletNetwork;
  networkLoaded: boolean;
  initializationDetails: string | null;
  sessions: WalletConnectSession[];
  prompt: WalletPrompt | null;
  error: string;
  message: string;
  invoice: {
    invoice: string;
    assetId?: string;
    amount?: number;
    expirationTimestamp?: number | null;
    source: string;
  } | null;
  btcBalance: Awaited<ReturnType<AnyUtexoWallet['getBtcBalance']>> | null;
  assets: WalletAsset[];
  transfers: (WalletTransfer & { assetId: string })[];
  updatedAt: number | null;
  refreshing: boolean;
  activeRequest: string;
  lastRequest: { method: string; status: 'completed' | 'failed'; error?: string } | null;
  burnAvailable: boolean;
  burns: BurnOperationRecord[];
};

export type WalletAsset = {
  assetId: string;
  name: string;
  ticker?: string;
  schema: string;
  precision: number;
  balance: { spendable: number; settled: number; future: number };
};
