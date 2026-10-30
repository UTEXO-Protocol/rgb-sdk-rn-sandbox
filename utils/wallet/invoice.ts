import type { WalletTransfer } from '@utexo/rgb-sdk-rn';

// Leave time for approval and bridge preparation before the one-hour mint window.
export const MIN_INVOICE_DURATION_MINUTES = 3 * 60;
export const MIN_INVOICE_DURATION_SECONDS = MIN_INVOICE_DURATION_MINUTES * 60;

export function canCancelInvoice(transfer: WalletTransfer): boolean {
  return (transfer.kind === 'ReceiveBlind' || transfer.kind === 'ReceiveWitness') &&
    transfer.status === 'WaitingCounterparty' && !transfer.txid &&
    Number.isInteger(transfer.batchTransferIdx) &&
    transfer.batchTransferIdx! > 0 && transfer.batchTransferIdx! <= 0x7fffffff;
}
