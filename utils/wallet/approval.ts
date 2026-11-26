import type { WebRgbApproval } from '@utexo/rgb-sdk/webrgb';

/** Prompt text for the WebRGB 0.2 confirmations; burn and invoice prompts are below. */
export function approvalText(request: WebRgbApproval, network: string): { title: string; details: string } | null {
  const p = request.params;
  switch (request.method) {
    case 'createUtxos':
      return {
        title: 'Create UTXOs?',
        details: `Count: ${p.num ?? 'wallet default'}\nSize: ${p.size ?? 'wallet default'} sat each\nBTC fee rate: ${p.feeRate ?? 'wallet default'} sat/vB\nNetwork: ${network}\nThis spends bitcoin from the wallet.`,
      };
    case 'cancelReceive':
      return {
        title: 'Cancel receive invoice?',
        details: `Recipient ID: ${p.recipientId}\nKind: ${p.kind}\nAmount: ${p.amount ?? 'Any amount'} base units\nA sender can no longer pay this invoice.`,
      };
    case 'signPsbt': {
      const outputs = (p.outputs as { address: string | null; amount: number }[] | undefined) ?? [];
      return {
        title: 'Sign transaction?',
        details: [
          ...outputs.map((out, i) => `Output ${i}: ${out.amount} sat to ${out.address ?? 'a script without an address'}`),
          `Fee: ${p.fee === null || p.fee === undefined ? 'unknown' : `${p.fee} sat`}`,
          `Inputs signed by this wallet: ${(p.signedInputs as number[] | undefined)?.join(', ') ?? 'none'}`,
          `Finalize: ${p.finalize ? 'yes' : 'no'}`,
          `Network: ${network}`,
        ].join('\n'),
      };
    }
    default:
      return null;
  }
}
