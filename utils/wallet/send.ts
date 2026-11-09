import type { UTEXOWallet } from '@utexo/rgb-sdk-rn';
import type { DemoWalletNetwork } from '../env';
import type { WalletAsset } from './types';
import { burnBaseUnits } from './burn';

export type LocalSendInput = { assetId: string; amount: string; invoice: string };
type DecodedInvoice = Awaited<ReturnType<UTEXOWallet['decodeRGBInvoice']>>;

export const canSendAsset = (asset: WalletAsset) =>
  ['BFA', 'NIA', 'CFA'].includes(asset.schema);

/** The SDK send API uses JS numbers; never silently round base units. */
export function prepareSendInput(input: LocalSendInput, asset: WalletAsset | undefined) {
  if (!asset || asset.assetId !== input.assetId || !canSendAsset(asset))
    throw new Error('Select a fungible RGB token in this wallet.');
  const invoice = input.invoice.trim();
  if (!invoice.startsWith('rgb:') || /\s/.test(invoice) || invoice.length > 16384)
    throw new Error('Paste the full RGB invoice from the receiving wallet.');
  const beneficiary = invoice.split('?')[0].split('/').at(-1) || '';
  if (!/(?:^|:)utxob:/.test(beneficiary))
    throw new Error('Use a blinded RGB invoice for this transfer.');
  const query = new URLSearchParams(invoice.split('?')[1] || '');
  if (query.has('amount'))
    throw new Error('This invoice has an unsupported amount field. Ask the receiving wallet to create a new invoice.');
  if (query.getAll('pk').length !== 1 || !/^[0-9a-f]{64}$/i.test(query.get('pk') || ''))
    throw new Error('The invoice is missing receiving details. Ask for a new RGB invoice.');
  const amount = burnBaseUnits(input.amount, asset.precision);
  if (BigInt(amount) > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('This amount exceeds the supported transfer range.');
  assertSendBalance(amount, asset.balance.spendable);
  return { invoice, assetId: asset.assetId, amount: Number(amount) };
}

export function assertSendBalance(amount: string, balance: number | undefined) {
  if (typeof balance !== 'number' || !Number.isSafeInteger(balance) || balance < 0)
    throw new Error('Refresh the wallet to load the available token balance.');
  if (BigInt(amount) > BigInt(balance))
    throw new Error('Amount exceeds the available token balance.');
}

export function assertSendInvoice(
  decoded: DecodedInvoice,
  params: ReturnType<typeof prepareSendInput>,
  network: DemoWalletNetwork,
) {
  // Dev uses the Utexo custom Signet; invoices use the Signet address prefix.
  const expectedNetwork = network === 'utexo' ? 'signet' : 'regtest';
  if (decoded.network !== expectedNetwork)
    throw new Error('The invoice belongs to a different Bitcoin network.');
  if (!decoded.recipientId || !decoded.transportEndpoints?.length)
    throw new Error('The invoice is missing receiving details. Ask for a new RGB invoice.');
  if (decoded.assetId && decoded.assetId !== params.assetId)
    throw new Error('The invoice is for a different token.');
  if (decoded.expirationTimestamp === null || decoded.expirationTimestamp === undefined)
    throw new Error('This invoice has no expiry. Ask for a new invoice with an expiration time.');
  if (!Number.isSafeInteger(decoded.expirationTimestamp) || decoded.expirationTimestamp * 1000 <= Date.now())
    throw new Error('This invoice has expired. Ask for a new one.');
  // rgb-lib requires 5 minutes for the operation and a 10-minute invoice margin;
  // leave one additional minute for preparation before the native call.
  if (decoded.expirationTimestamp * 1000 < Date.now() + 16 * 60 * 1000)
    throw new Error('This invoice expires too soon. Ask for a new invoice with at least 16 minutes remaining.');
  if (decoded.assignment.type === 'Fungible') {
    if (!Number.isSafeInteger(decoded.assignment.amount) ||
        (decoded.assignment.amount !== 0 && decoded.assignment.amount !== params.amount))
      throw new Error('The entered amount must match the amount in the invoice.');
  } else if (decoded.assignment.type !== 'Any') {
    throw new Error('This invoice does not accept a fungible token transfer.');
  }
}
