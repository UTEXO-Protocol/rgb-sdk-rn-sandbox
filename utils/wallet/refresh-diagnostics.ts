import type { UTEXOWallet } from '@utexo/rgb-sdk-rn';

export type WalletRefreshDiagnostics = {
  network: string;
  startedAt: number;
  finishedAt: number;
  transfers: Awaited<ReturnType<UTEXOWallet['refreshTransfers']>>['transfers'] | null;
  activity?: {
    snapshotAt: number | null;
    transfers: { transferIdx: number; assetId: string; kind: string; status: string; txid?: string; recipientId?: string }[];
  };
  error?: {
    stage: 'persistence' | 'refresh' | 'readWalletData';
    name: string;
    message: string;
  };
};

export function formatRefreshDiagnostics(report: WalletRefreshDiagnostics, appVersion: string) {
  return JSON.stringify({
    format: 'utexo-wallet-refresh',
    version: 1,
    appVersion,
    network: report.network,
    startedAt: new Date(report.startedAt).toISOString(),
    finishedAt: new Date(report.finishedAt).toISOString(),
    skipSync: false,
    // Refresh keys identify batches, not the individual history Transfer.idx.
    batches: report.transfers === null ? null : Object.entries(report.transfers).map(([idx, result]) => ({
      batchTransferIdx: Number(idx),
      updatedStatus: result.updatedStatus ?? null,
      failure: result.failure ?? null,
    })),
    // Separate history snapshot: native refresh batches and history transfer IDs differ.
    activity: report.activity ?? null,
    error: report.error ?? null,
  }, null, 2);
}
