import type { UTEXOWallet } from '@utexo/rgb-sdk-rn';

import { normHash, short, type LogEntry } from './config';

function chanField<T>(c: Record<string, unknown>, camel: string, snake: string): T | undefined {
  return (c[camel] ?? c[snake]) as T | undefined;
}

export type RgbBalanceSnap = {
  offchainOutbound: number;
  offchainInbound: number;
  settled: number;
  spendable: number;
  localRgb?: number;
  remoteRgb?: number;
};

export async function snapshotRgbBalances(
  wallet: UTEXOWallet<'RGB_LN'>,
  assetId: string,
  lspPubkey: string,
): Promise<RgbBalanceSnap> {
  const bal = await wallet.getAssetBalance(assetId).catch(() => null);
  const chans = await wallet.listChannels().catch(() => []);
  const ch = chans.find(c => {
    const row = c as unknown as Record<string, unknown>;
    const peer = String(chanField<string>(row, 'peerPubkey', 'peer_pubkey') ?? '');
    const asset = String(chanField<string>(row, 'assetId', 'asset_id') ?? '');
    return peer === lspPubkey && asset === assetId;
  });
  const chRow = ch != null ? (ch as unknown as Record<string, unknown>) : null;
  return {
    offchainOutbound: Number(bal?.offchainOutbound ?? 0),
    offchainInbound: Number(bal?.offchainInbound ?? 0),
    settled: Number(bal?.settled ?? 0),
    spendable: Number(bal?.spendable ?? 0),
    localRgb: chRow != null
      ? Number(chanField<number>(chRow, 'assetLocalAmount', 'asset_local_amount') ?? 0)
      : undefined,
    remoteRgb: chRow != null
      ? Number(chanField<number>(chRow, 'assetRemoteAmount', 'asset_remote_amount') ?? 0)
      : undefined,
  };
}

export function logRgbBalanceSnap(
  role: string,
  when:
    | 'START (after channel)'
    | 'START (pre-checkout)'
    | 'START (pre-topup)'
    | 'START (pre-relay)'
    | 'END (settled)'
    | 'END (after refund)'
    | 'END (after topup)',
  snap: RgbBalanceSnap,
  addLog: (msg: string, type?: LogEntry['type']) => void,
): void {
  const chan =
    snap.localRgb != null
      ? ` | chan local=${snap.localRgb} remote=${snap.remoteRgb}`
      : '';
  addLog(
    `balance ${when} — ${role}: offchainOutbound(local)=${snap.offchainOutbound} ` +
      `offchainInbound(remote)=${snap.offchainInbound} settled=${snap.settled} spendable=${snap.spendable}${chan}`,
    when.startsWith('END') ? 'success' : 'info',
  );
}

export function logRgbBalanceDelta(
  role: string,
  before: RgbBalanceSnap,
  after: RgbBalanceSnap,
  addLog: (msg: string, type?: LogEntry['type']) => void,
): void {
  const dOut = after.offchainOutbound - before.offchainOutbound;
  const dIn = after.offchainInbound - before.offchainInbound;
  addLog(
    `balance Δ ${role}: offchainOutbound ${before.offchainOutbound}→${after.offchainOutbound} (${dOut >= 0 ? '+' : ''}${dOut}) ` +
      `offchainInbound ${before.offchainInbound}→${after.offchainInbound} (${dIn >= 0 ? '+' : ''}${dIn})`,
    'success',
  );
}

export async function logSettlementDiagnostics(
  wA: UTEXOWallet<'RGB_LN'>,
  wB: UTEXOWallet<'RGB_LN'>,
  paymentHash: string,
  lspPubkey: string,
  assetId: string,
  addLog: (msg: string, type?: LogEntry['type']) => void,
): Promise<void> {
  try {
    const [buyerPays, merchantPays, buyerChans, merchantChans, peers] = await Promise.all([
      wA.listPayments().catch(() => []),
      wB.listPayments().catch(() => []),
      wA.listChannels().catch(() => []),
      wB.listChannels().catch(() => []),
      wB.listPeers().catch(() => []),
    ]);

    const n = normHash(paymentHash);
    const bp = buyerPays.find(p => normHash(p.paymentHash) === n);
    const mp = merchantPays.find(p => normHash(p.paymentHash) === n);

    addLog(
      `diag buyer outbound: ${bp
        ? `${bp.status}/${bp.paymentType ?? '?'} msat=${bp.amtMsat ?? '?'} rgb=${bp.assetAmount ?? '?'}`
        : 'not in listPayments'}`,
    );
    addLog(
      `diag merchant inbound (hash): ${mp
        ? `${mp.status}/${mp.paymentType ?? '?'} preimage=${mp.preimage ? 'yes' : 'no'}`
        : 'not in listPayments'}`,
    );

    const inbound = merchantPays.filter(p =>
      String(p.paymentType ?? '').toLowerCase().includes('inbound'),
    );
    if (inbound.length) {
      const brief = inbound
        .slice(0, 4)
        .map(p => `${short(p.paymentHash, 8)}=${p.status}/${p.paymentType ?? '?'}`)
        .join(' ');
      addLog(`diag merchant inbound (${inbound.length}): ${brief}`);
    } else {
      addLog('diag merchant inbound: none in listPayments');
    }

    const pickLspChan = (chans: typeof buyerChans) =>
      chans.find(c => {
        const row = c as unknown as Record<string, unknown>;
        const peer = String(chanField<string>(row, 'peerPubkey', 'peer_pubkey') ?? '');
        const asset = String(chanField<string>(row, 'assetId', 'asset_id') ?? '');
        return peer === lspPubkey && asset === assetId;
      });

    const mChan = pickLspChan(merchantChans);
    const aChan = pickLspChan(buyerChans);
    if (mChan) {
      const row = mChan as unknown as Record<string, unknown>;
      addLog(
        `diag merchant→LSP chan: localRgb=${chanField<number>(row, 'assetLocalAmount', 'asset_local_amount') ?? '?'} ` +
        `remoteRgb=${chanField<number>(row, 'assetRemoteAmount', 'asset_remote_amount') ?? '?'} ` +
        `usable=${chanField<boolean>(row, 'isUsable', 'is_usable') ?? '?'}`,
      );
    }
    if (aChan) {
      const row = aChan as unknown as Record<string, unknown>;
      addLog(
        `diag buyer→LSP chan: localRgb=${chanField<number>(row, 'assetLocalAmount', 'asset_local_amount') ?? '?'} ` +
        `remoteRgb=${chanField<number>(row, 'assetRemoteAmount', 'asset_remote_amount') ?? '?'}`,
      );
    }

    addLog(`diag merchant peers connected: ${peers.length}`);
  } catch (e: any) {
    addLog(`diag error: ${e?.message ?? String(e)}`);
  }
}
