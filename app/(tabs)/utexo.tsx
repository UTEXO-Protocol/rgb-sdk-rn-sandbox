import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';
import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppColors } from '@/constants/theme';
import { buildRegtestConfig, buildUtexoConfig } from '@/utils/env';
import { waitForAssetSpendable } from '@/utils/flow-core';
import { mine, sendToAddress } from '@/utils/wallet-flow';
import { createWallet, PasswordRLNSigner, UTEXOWallet } from '@utexo/rgb-sdk-rn';

// ── UTEXO node credentials (set in .env.local) ───────────────────────────────
const UTEXO_UNLOCK = buildUtexoConfig().unlockParams;

// ── Local regtest node credentials ────────────────────────────────────────────
const _rpcHost = Platform.OS === 'android' ? '10.0.2.2' : '127.0.0.1';
// Shared regtest config (indexer-only, no bitcoind RPC) — same as the other flows.
const REGTEST_UNLOCK = buildRegtestConfig().unlockParams;

const POLL_MS = 20_000;
const FUND_TIMEOUT_MS = 45 * 60 * 1000;
const CONFIRM_TIMEOUT_MS = 45 * 60 * 1000;
const PAY_TIMEOUT_MS = 60_000;
// Funding tx appears in channel list quickly (mempool) — 3 min covers both networks.
const CHANNEL_TX_TIMEOUT_MS = 3 * 60 * 1000;
// Channel becomes usable after 6 block confirmations: ~seconds on regtest, ~60 min on utexo.
const CHANNEL_USABLE_TIMEOUT_MS_REGTEST = 3 * 60 * 1000;
const CHANNEL_USABLE_TIMEOUT_MS_UTEXO   = 90 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────────────────
type Phase = 'idle' | 'init' | 'fund' | 'utxos' | 'channel' | 'payments' | 'done' | 'error';
interface LogEntry { time: string; msg: string; type: 'info' | 'success' | 'error' }
interface BtcBal { settled: number; future: number; spendable: number }
interface Balance { vanilla: BtcBal; colored: BtcBal }
interface PayResult { direction: string; amount: number; hash: string; status: string }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function satStr(n: number): string {
  if (n === 0) return '0 sat';
  if (n < 1000) return `${n} sat`;
  return `${(n / 100_000_000).toFixed(8)} BTC`;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function PhaseBar({ phase }: { phase: Phase }) {
  const phases: { id: Phase; label: string }[] = [
    { id: 'init',     label: 'Init'     },
    { id: 'fund',     label: 'Fund'     },
    { id: 'utxos',    label: 'UTXOs'    },
    { id: 'channel',  label: 'Channel'  },
    { id: 'payments', label: 'Payments' },
    { id: 'done',     label: 'Done'     },
  ];
  const order = phases.map(p => p.id);
  const current = order.indexOf(phase as any);

  return (
    <View style={pb.row}>
      {phases.map((p, i) => {
        const done   = current > i;
        const active = current === i;
        const err    = phase === 'error' && active;
        const color  = err ? AppColors.error : done ? AppColors.success : active ? AppColors.primary : AppColors.textTertiary;
        return (
          <React.Fragment key={p.id}>
            <View style={pb.step}>
              <View style={[pb.dot, { borderColor: color, backgroundColor: active ? color + '20' : 'transparent' }]}>
                {active && phase !== 'error' ? (
                  <ActivityIndicator size={10} color={color} />
                ) : (
                  <Text style={[pb.dotText, { color }]}>{done ? '✓' : err ? '✗' : i + 1}</Text>
                )}
              </View>
              <Text style={[pb.label, { color }]}>{p.label}</Text>
            </View>
            {i < phases.length - 1 && (
              <View style={[pb.line, { backgroundColor: done ? AppColors.success + '60' : AppColors.border }]} />
            )}
          </React.Fragment>
        );
      })}
    </View>
  );
}

function NodeFundCard({
  label, address, balance,
}: { label: string; address: string; balance: Balance | null }) {
  const settled   = (balance?.vanilla?.settled   ?? 0) + (balance?.colored?.settled   ?? 0);
  const future    = (balance?.vanilla?.future    ?? 0) + (balance?.colored?.future    ?? 0);
  const spendable = (balance?.vanilla?.spendable ?? 0) + (balance?.colored?.spendable ?? 0);
  return (
    <View style={nf.card}>
      <Text style={nf.label}>{label}</Text>
      <View style={nf.addrBox}>
        <Text selectable style={nf.addr}>{address || '…'}</Text>
      </View>
      <View style={nf.balRow}>
        <View style={nf.balItem}>
          <Text style={nf.balKey}>Confirmed</Text>
          <Text style={[nf.balVal, settled > 0 && { color: AppColors.success }]}>{satStr(settled)}</Text>
        </View>
        <View style={nf.balDivider} />
        <View style={nf.balItem}>
          <Text style={nf.balKey}>Pending</Text>
          <Text style={[nf.balVal, future > 0 && { color: AppColors.warning }]}>{satStr(future)}</Text>
        </View>
        <View style={nf.balDivider} />
        <View style={nf.balItem}>
          <Text style={nf.balKey}>Spendable</Text>
          <Text style={[nf.balVal, spendable > 0 && { color: AppColors.primary }]}>{satStr(spendable)}</Text>
        </View>
      </View>
      {settled > 0
        ? <View style={[nf.badge, { backgroundColor: AppColors.successBg }]}>
            <Text style={[nf.badgeTxt, { color: AppColors.success }]}>✓ Funded</Text>
          </View>
        : future > 0
          ? <View style={[nf.badge, { backgroundColor: AppColors.warningBg }]}>
              <ActivityIndicator size={10} color={AppColors.warning} style={{ marginRight: 4 }} />
              <Text style={[nf.badgeTxt, { color: AppColors.warning }]}>Tx seen — waiting for block…</Text>
            </View>
          : <View style={nf.badge}>
              <ActivityIndicator size={10} color={AppColors.textTertiary} style={{ marginRight: 4 }} />
              <Text style={nf.badgeTxt}>Polling every 20s…</Text>
            </View>
      }
    </View>
  );
}

function ChannelCard({ channelId, fundingTxid, assetId, network }: { channelId: string; fundingTxid: string; assetId: string; network: 'utexo' | 'regtest' }) {
  return (
    <View style={ch.card}>
      <ActivityIndicator size={18} color={AppColors.primary} style={{ marginBottom: 10 }} />
      <Text style={ch.title}>Channel Opening</Text>
      {fundingTxid
        ? <Text style={ch.line}>Funding tx: {fundingTxid.slice(0, 20)}…</Text>
        : <Text style={ch.line}>Waiting for funding tx…</Text>}
      {channelId ? <Text style={ch.line}>Channel: {channelId.slice(0, 20)}…</Text> : null}
      {assetId ? <Text style={ch.line}>Asset: {assetId.slice(0, 24)}…</Text> : null}
      <Text style={ch.sub}>
        {network === 'regtest'
          ? 'Mining 6 blocks for confirmation…'
          : 'Waiting for 6 block confirmations (~60 min on utexo)…'}
      </Text>
    </View>
  );
}

function PaymentsCard({ results }: { results: PayResult[] }) {
  return (
    <View style={pm.card}>
      <Text style={pm.title}>Lightning Payments</Text>
      {results.map((r, i) => (
        <View key={i} style={pm.row}>
          <Text style={pm.dir}>{r.direction}</Text>
          <Text style={pm.amount}>{r.amount} units</Text>
          <Text style={[pm.status,
            r.status === 'Settled' && { color: AppColors.success },
            r.status === 'Failed'  && { color: AppColors.error },
          ]}>{r.status === 'Settled' ? '✓ Settled' : r.status === 'Failed' ? '✗ Failed' : '⋯ Pending'}</Text>
        </View>
      ))}
      {results.length === 0 && <ActivityIndicator size={16} color={AppColors.primary} />}
    </View>
  );
}

function DoneCard({
  nodeInfoA, nodeInfoB, balanceA, balanceB, assetInfo, assetBalA, assetBalB, payResults, channelId,
}: {
  nodeInfoA: any; nodeInfoB: any;
  balanceA: Balance | null; balanceB: Balance | null;
  assetInfo: any; assetBalA: any; assetBalB: any;
  payResults: PayResult[]; channelId: string;
}) {
  return (
    <View style={dc.card}>
      <Text style={dc.badge}>✓ FLOW COMPLETE</Text>

      {/* Asset */}
      {assetInfo && (
        <View style={dc.section}>
          <Text style={dc.sectionTitle}>RGB Asset Issued on Node A</Text>
          <Text selectable style={dc.mono}>{String(assetInfo.assetId ?? '')}</Text>
          <Text style={dc.detail}>{assetInfo.ticker} · {assetInfo.name} · supply: {assetInfo.issuedSupply}</Text>
        </View>
      )}

      {/* Channel */}
      {channelId && (
        <View style={dc.section}>
          <Text style={dc.sectionTitle}>Channel</Text>
          <Text selectable style={dc.mono}>{channelId}</Text>
        </View>
      )}

      {/* Payments */}
      {payResults.length > 0 && (
        <View style={dc.section}>
          <Text style={dc.sectionTitle}>Payments</Text>
          {payResults.map((r, i) => (
            <Text key={i} style={dc.detail}>{r.direction}  {r.amount} units  {r.status === 'Settled' ? '✓' : '✗'}</Text>
          ))}
        </View>
      )}

      {/* Node A */}
      <View style={dc.section}>
        <Text style={dc.sectionTitle}>Node A</Text>
        <Text selectable style={dc.mono}>{String(nodeInfoA?.pubkey ?? '').slice(0, 32)}…</Text>
        <Text style={dc.detail}>
          BTC spendable: {satStr((balanceA?.vanilla?.spendable ?? 0) + (balanceA?.colored?.spendable ?? 0))}
          {assetBalA != null ? `  ·  Asset: ${assetBalA.spendable} units` : ''}
        </Text>
      </View>

      {/* Node B */}
      <View style={dc.section}>
        <Text style={dc.sectionTitle}>Node B</Text>
        <Text selectable style={dc.mono}>{String(nodeInfoB?.pubkey ?? '').slice(0, 32)}…</Text>
        <Text style={dc.detail}>
          BTC spendable: {satStr((balanceB?.vanilla?.spendable ?? 0) + (balanceB?.colored?.spendable ?? 0))}
          {assetBalB != null ? `  ·  Asset: ${assetBalB.spendable} units` : ''}
        </Text>
      </View>
    </View>
  );
}

function LogPane({ entries }: { entries: LogEntry[] }) {
  return (
    <View style={lp.box}>
      <Text style={lp.header}>Console</Text>
      {entries.length === 0 && <Text style={lp.empty}>No output yet</Text>}
      {entries.map((e, i) => (
        <Text
          key={i}
          style={[
            lp.entry,
            e.type === 'success' && { color: AppColors.success },
            e.type === 'error'   && { color: AppColors.error },
          ]}>
          {e.time}  {e.msg}
        </Text>
      ))}
    </View>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────────
export default function UtexoScreen() {
  const [phase, setPhase]               = useState<Phase>('idle');
  const [selectedNetwork, setSelectedNetwork] = useState<'utexo' | 'regtest'>('utexo');
  const [addressA, setAddressA]         = useState('');
  const [addressB, setAddressB]         = useState('');
  const [balanceA, setBalanceA]         = useState<Balance | null>(null);
  const [balanceB, setBalanceB]         = useState<Balance | null>(null);
  const [nodeInfoA, setNodeInfoA]       = useState<any>(null);
  const [nodeInfoB, setNodeInfoB]       = useState<any>(null);
  const [assetInfo, setAssetInfo]       = useState<any>(null);
  const [channelId, setChannelId]       = useState('');
  const [fundingTxid, setFundingTxid]   = useState('');
  const [payResults, setPayResults]     = useState<PayResult[]>([]);
  const [assetBalA, setAssetBalA]       = useState<any>(null);
  const [assetBalB, setAssetBalB]       = useState<any>(null);
  const [errorMsg, setErrorMsg]         = useState('');
  const [log, setLog]                   = useState<LogEntry[]>([]);

  const walletARef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const walletBRef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const abortRef   = useRef(false);
  const activeNetworkRef = useRef<'utexo' | 'regtest'>('utexo');
  const portBRef   = useRef(0);

  const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString('en', { hour12: false });
    setLog(prev => [...prev.slice(-200), { time, msg, type }]);
    console.log(`[utexo] [${type}] ${msg}`);
  }, []);

  const start = useCallback(async () => {
    const network   = selectedNetwork;
    const isRegtest = network === 'regtest';
    activeNetworkRef.current = network;
    abortRef.current = false;
    setLog([]);
    setAddressA(''); setAddressB('');
    setBalanceA(null); setBalanceB(null);
    setNodeInfoA(null); setNodeInfoB(null);
    setAssetInfo(null);
    setChannelId(''); setFundingTxid('');
    setPayResults([]);
    setAssetBalA(null); setAssetBalB(null);
    setErrorMsg('');
    setPhase('init');

    const req = (label: string, params?: Record<string, any>) => {
      const p = params
        ? '  ' + Object.entries(params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ')
        : '';
      addLog(`→ ${label}${p}`);
    };
    const res = (label: string, data?: Record<string, any>) => {
      const d = data
        ? '  ' + Object.entries(data).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ')
        : '';
      addLog(`← ${label}${d}`, 'success');
    };

    try {
      // ── 1. Create keys ─────────────────────────────────────────────────────
      req('createWallet', { node: 'A', network });
      const keysA = await createWallet(network as any);
      res('createWallet nodeA', { fingerprint: keysA.masterFingerprint });

      req('createWallet', { node: 'B', network });
      const keysB = await createWallet(network as any);
      res('createWallet nodeB', { fingerprint: keysB.masterFingerprint });

      // ── 2. Build wallets ───────────────────────────────────────────────────
      const ts    = Date.now();
      const portA = 32000 + Math.floor(Math.random() * 5000);
      const portB = portA + 100;
      portBRef.current = portB;

      const makeDirAndPath = async (suffix: string) => {
        const uri = `${documentDirectory ?? ''}utexo_${suffix}_${ts}`;
        await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
        return uri.replace('file://', '');
      };

      const storageDirA = await makeDirAndPath('a');
      const storageDirB = await makeDirAndPath('b');
      addLog(`StorageA: ${storageDirA}`);
      addLog(`StorageB: ${storageDirB}`);

      const wA = new UTEXOWallet(
        { storageDirPath: storageDirA, daemonListeningPort: portA, ldkPeerListeningPort: portA + 1,
          network, enableVirtualChannelsV0: false,
        },
        new PasswordRLNSigner('password', keysA.mnemonic),
      );
      const wB = new UTEXOWallet(
        { storageDirPath: storageDirB, daemonListeningPort: portB, ldkPeerListeningPort: portB + 1,
          network, enableVirtualChannelsV0: false,
        },
        new PasswordRLNSigner('password', keysB.mnemonic),
      );
      walletARef.current = wA;
      walletBRef.current = wB;

      // ── 3. Init ────────────────────────────────────────────────────────────
      req('nodeA.init');
      console.log('wA', wA);
      await wA.init();
      res('nodeA.init');

      req('nodeB.init');
      await wB.init();
      res('nodeB.init');

      // ── 4. Unlock ──────────────────────────────────────────────────────────
      const unlockParams = isRegtest ? REGTEST_UNLOCK : UTEXO_UNLOCK;
      console.log('unlockParams', unlockParams);
      req('nodeA.unlock', { indexer: unlockParams.indexerUrl, proxy: unlockParams.proxyEndpoint });
      await wA.unlock(unlockParams);
      res('nodeA.unlock');

      req('nodeB.unlock', { indexer: unlockParams.indexerUrl, proxy: unlockParams.proxyEndpoint });
      await wB.unlock(unlockParams);
      res('nodeB.unlock');

      // ── 5. Node info ───────────────────────────────────────────────────────
      req('nodeA.getNodeInfo');
      const infoA0 = await wA.getNodeInfo();
      setNodeInfoA(infoA0);
      res('nodeA.getNodeInfo', { pubkey: String(infoA0?.pubkey ?? '').slice(0, 20) + '…', channels: infoA0?.numChannels });

      req('nodeB.getNodeInfo');
      const infoB0 = await wB.getNodeInfo();
      setNodeInfoB(infoB0);
      res('nodeB.getNodeInfo', { pubkey: String(infoB0?.pubkey ?? '').slice(0, 20) + '…', channels: infoB0?.numChannels });

      req('nodeA.getNetworkInfo');
      const netInfo = await wA.getNetworkInfo();
      res('nodeA.getNetworkInfo', { network: netInfo.network, height: netInfo.blockHeight });

      // ── 6. Addresses ───────────────────────────────────────────────────────
      req('nodeA.getAddress');
      const addrA = await wA.getAddress();
      setAddressA(addrA);
      res('nodeA.getAddress', { address: addrA });

      req('nodeB.getAddress');
      const addrB = await wB.getAddress();
      setAddressB(addrB);
      res('nodeB.getAddress', { address: addrB });

      // ── 7. Fund ───────────────────────────────────────────────────────────
      setPhase('fund');
      let settledA = 0, settledB = 0;

      if (isRegtest) {
        req('sendToAddress', { address: addrA, amountBtc: 1 });
        const txidA = await sendToAddress(addrA, 1);
        res('sendToAddress nodeA', { txid: txidA });

        req('sendToAddress', { address: addrB, amountBtc: 1 });
        const txidB = await sendToAddress(addrB, 1);
        res('sendToAddress nodeB', { txid: txidB });

        req('mine', { blocks: 6 });
        await mine(6);
        res('mine', { blocks: 6 });

        await sleep(3000);

        req('nodeA.syncWallet');
        await wA.syncWallet();
        res('nodeA.syncWallet');

        req('nodeA.getBtcBalance');
        const balA0 = await wA.getBtcBalance() as Balance;
        setBalanceA(balA0);
        settledA = (balA0?.vanilla?.settled ?? 0) + (balA0?.colored?.settled ?? 0);
        res('nodeA.getBtcBalance', { settled: satStr(settledA), spendable: satStr(balA0?.vanilla?.spendable ?? 0) });

        req('nodeB.syncWallet');
        await wB.syncWallet();
        res('nodeB.syncWallet');

        req('nodeB.getBtcBalance');
        const balB0 = await wB.getBtcBalance() as Balance;
        setBalanceB(balB0);
        settledB = (balB0?.vanilla?.settled ?? 0) + (balB0?.colored?.settled ?? 0);
        res('nodeB.getBtcBalance', { settled: satStr(settledB), spendable: satStr(balB0?.vanilla?.spendable ?? 0) });
      } else {
        // UTEXO: poll both addresses until both are funded
        addLog('Send BTC to BOTH addresses shown above — polling every 20s');
        const fundDeadline = Date.now() + FUND_TIMEOUT_MS;
        while (Date.now() < fundDeadline) {
          if (abortRef.current) throw new Error('Cancelled');
          await sleep(POLL_MS);
          try {
            if (settledA === 0) {
              req('nodeA.syncWallet');
              await wA.syncWallet();
              res('nodeA.syncWallet');
              req('nodeA.getBtcBalance');
              const b = await wA.getBtcBalance() as Balance;
              setBalanceA(b);
              settledA = (b?.vanilla?.settled ?? 0) + (b?.colored?.settled ?? 0);
              const futA = (b?.vanilla?.future ?? 0) + (b?.colored?.future ?? 0);
              res('nodeA.getBtcBalance', { settled: satStr(settledA), future: satStr(futA) });
            }
            if (settledB === 0) {
              req('nodeB.syncWallet');
              await wB.syncWallet();
              res('nodeB.syncWallet');
              req('nodeB.getBtcBalance');
              const b = await wB.getBtcBalance() as Balance;
              setBalanceB(b);
              settledB = (b?.vanilla?.settled ?? 0) + (b?.colored?.settled ?? 0);
              const futB = (b?.vanilla?.future ?? 0) + (b?.colored?.future ?? 0);
              res('nodeB.getBtcBalance', { settled: satStr(settledB), future: satStr(futB) });
            }
            if (settledA > 0 && settledB > 0) break;
          } catch (e: any) {
            addLog(`Poll error: ${e?.message ?? String(e)}`, 'error');
          }
        }
        if (settledA === 0 || settledB === 0)
          throw new Error('Timed out waiting for BTC on both nodes (45 min).');

        // UTEXO: wait for LDK to process the confirming block before createUtxos
        for (const [w, label] of [[wA, 'nodeA'], [wB, 'nodeB']] as [UTEXOWallet<'RGB_LN'>, string][]) {
          req(`${label}.getNetworkInfo`);
          const { blockHeight: h0 } = await w.getNetworkInfo();
          res(`${label}.getNetworkInfo`, { height: h0 });
          addLog(`Waiting for ${label} LDK to advance past block ${h0}…`);
          const deadline = Date.now() + 3 * 60 * 1000;
          while (Date.now() < deadline) {
            if (abortRef.current) throw new Error('Cancelled');
            await sleep(5_000);
            req(`${label}.getNetworkInfo`);
            const info = await w.getNetworkInfo();
            res(`${label}.getNetworkInfo`, { height: info.blockHeight, waitingFor: (h0 ?? 0) + 1 });
            if ((info.blockHeight ?? 0) > (h0 ?? 0)) break;
          }
        }
      }

      // ── 8. Create UTXOs ────────────────────────────────────────────────────
      setPhase('utxos');

      for (const [w, label, settled] of [
        [wA, 'nodeA', settledA],
        [wB, 'nodeB', settledB],
      ] as [UTEXOWallet<'RGB_LN'>, string, number][]) {
        req(`${label}.syncWallet`);
        await w.syncWallet();
        res(`${label}.syncWallet`);

        req(`${label}.refreshWallet`);
        await w.refreshWallet();
        res(`${label}.refreshWallet`);

        req(`${label}.listUnspents`);
        const unspentsBefore = await w.listUnspents();
        res(`${label}.listUnspents`, { count: unspentsBefore.length });

        await sleep(2000);

        const num = 10;
        const feeRate = isRegtest ? 7 : 2;
        req(`${label}.createUtxos`, { upTo: false, num, feeRate });
        await w.createUtxos({ upTo: false, num, feeRate });
        res(`${label}.createUtxos`, { requested: num });

        if (isRegtest) {
          req('mine', { blocks: 1 });
          await mine(1);
          res('mine', { blocks: 1 });

          req(`${label}.syncWallet`);
          await w.syncWallet();
          res(`${label}.syncWallet`);

          req(`${label}.getBtcBalance`);
          const bal = await w.getBtcBalance() as Balance;
          if (label === 'nodeA') setBalanceA(bal); else setBalanceB(bal);
          res(`${label}.getBtcBalance`, {
            settled: satStr((bal?.vanilla?.settled ?? 0) + (bal?.colored?.settled ?? 0)),
            spendable: satStr((bal?.vanilla?.spendable ?? 0) + (bal?.colored?.spendable ?? 0)),
          });
        } else {
          // UTEXO: poll for UTXO tx confirmation
          addLog(`Waiting for ${label} UTXO tx block confirmation…`);
          const confirmDeadline = Date.now() + CONFIRM_TIMEOUT_MS;
          let confirmed = false;
          while (Date.now() < confirmDeadline) {
            if (abortRef.current) throw new Error('Cancelled');
            await sleep(POLL_MS);
            try {
              req(`${label}.syncWallet`);
              await w.syncWallet();
              res(`${label}.syncWallet`);
              req(`${label}.getBtcBalance`);
              const bal = await w.getBtcBalance() as Balance;
              if (label === 'nodeA') setBalanceA(bal); else setBalanceB(bal);
              const sp = (bal?.vanilla?.spendable ?? 0) + (bal?.colored?.spendable ?? 0);
              res(`${label}.getBtcBalance`, { spendable: satStr(sp) });
              if (sp > 0 && sp < settled) { confirmed = true; break; }
            } catch (e: any) { addLog(`Poll error: ${e?.message ?? String(e)}`, 'error'); }
          }
          if (!confirmed) addLog(`${label} UTXO confirmation timeout — continuing anyway`);
        }

        req(`${label}.listUnspents`);
        const unspentsAfter = await w.listUnspents();
        res(`${label}.listUnspents`, { count: unspentsAfter.length });
      }

      // ── 9. Issue asset on Node A ───────────────────────────────────────────
      setPhase('channel');

      req('nodeA.issueAssetNia', { ticker: 'UTXO', name: 'UTEXO Token', precision: 0, amounts: [1000] });
      const asset = await wA.issueAssetNia({ ticker: 'UTXO', name: 'UTEXO Token', precision: 0, amounts: [1000] });
      const assetId = String(asset?.assetId ?? '');
      if (!assetId) throw new Error('issueAssetNia returned no assetId');
      setAssetInfo(asset);
      res('nodeA.issueAssetNia', {
        assetId: assetId.slice(0, 24) + '…',
        ticker: asset?.ticker,
        issuedSupply: asset?.issuedSupply,
      });

      // ── TEMP DIAGNOSTIC: on-chain RGB asset send A → B (blindReceive + send) ──
      // Verifies whether on-chain colored transfers settle on this indexer-only
      // regtest config, to isolate whether the failure is specific to asset CHANNELS
      // or also affects plain on-chain RGB sends. Remove once that's confirmed.
      try {
        req('TEMP nodeB.blindReceive');
        const invOnchain = await wB.blindReceive({ minConfirmations: 1, durationSeconds: 3600 });
        res('TEMP nodeB.blindReceive', { recipientId: String(invOnchain.recipientId).slice(0, 20) + '…' });

        req('TEMP nodeA.send', { amount: 100, assetId: assetId.slice(0, 16) + '…' });
        await wA.onchainSend({ invoice: invOnchain.invoice, assetId, amount: 100, donation: true, feeRate: 1, minConfirmations: 1 });
        res('TEMP nodeA.send');

        await mine(1);
        await wB.syncWallet();
        await wB.refreshWallet();
        await wB.refreshWallet();
        await wA.refreshWallet();
        await mine(1);

        // TEMP(esplora): wait for the receiver's incoming transfer to confirm
        // before reading balances, to absorb the Esplora REST indexer's tip lag.
        await waitForAssetSpendable(wB, assetId, 100, { mine, attempts: 30, delayMs: 1000, label: 'utexo nodeB' });

        const balA = await wA.getAssetBalance(assetId).catch(() => null);
        const balB = await wB.getAssetBalance(assetId).catch(() => null);
        res('TEMP onchain-send balances', {
          nodeA_settled: balA?.settled, nodeA_spendable: balA?.spendable,
          nodeB_settled: balB?.settled, nodeB_spendable: balB?.spendable,
        });
        addLog(`TEMP on-chain A→B send: nodeB settled expected 100, got ${balB?.settled} (spendable ${balB?.spendable})`);
      } catch (e: any) {
        addLog(`TEMP on-chain send FAILED: ${e?.message ?? String(e)}`);
      }

      // ── 10. Node pubkeys ───────────────────────────────────────────────────
      req('nodeA.getNodeInfo');
      const infoA = await wA.getNodeInfo();
      setNodeInfoA(infoA);
      const pubkeyA = String(infoA?.pubkey ?? '');
      res('nodeA.getNodeInfo', { pubkey: pubkeyA.slice(0, 20) + '…' });

      req('nodeB.getNodeInfo');
      const infoB = await wB.getNodeInfo();
      setNodeInfoB(infoB);
      const pubkeyB = String(infoB?.pubkey ?? '');
      res('nodeB.getNodeInfo', { pubkey: pubkeyB.slice(0, 20) + '…' });

      // ── 11. Connect peers ──────────────────────────────────────────────────
      // LDK peer connection is always localhost — both nodes run in the same app process.
      const peerUriB = `${pubkeyB}@127.0.0.1:${portB + 1}`;
      req('nodeA.connectPeer', { peer: peerUriB.slice(0, 30) + '…' });
      try {
        await wA.connectPeer(peerUriB);
        res('nodeA.connectPeer');
      } catch (e: any) {
        addLog(`connectPeer warning (ignored): ${e?.message ?? String(e)}`);
      }

      req('nodeA.listPeers');
      const peers = await wA.listPeers();
      res('nodeA.listPeers', { count: peers?.length ?? 0 });

      // ── 12. Open channel A → B ─────────────────────────────────────────────
      const capacitySat = 100_000;
      const pushMsat    = 3_500_000;
      const assetAmount = 600;
      // TEMP(esplora): wait for nodeA's colored allocation to confirm (spendable>=assetAmount)
      // before opening the asset channel, to absorb the Esplora REST indexer's tip lag.
      // Remove when switching back to Electrum.
      await waitForAssetSpendable(wA, assetId, assetAmount, { mine, attempts: 30, delayMs: 1000, label: 'utexo nodeA' });
      req('nodeA.openChannel', { peer: pubkeyB.slice(0, 16) + '…', capacitySat, pushMsat, assetAmount, assetId: assetId.slice(0, 16) + '…' });
      await wA.openChannel({
        peerPubkey: peerUriB,
        capacitySat,
        pushMsat,
        isPublic: true,
        withAnchors: true,
        assetId,
        assetLocalAmount: assetAmount,
      });
      res('nodeA.openChannel', { capacitySat, assetAmount });

      // ── 13. Wait for funding tx ────────────────────────────────────────────
      addLog('Waiting for channel funding tx…');
      let chId = '', chFundingTxid = '';
      const fundDeadline = Date.now() + CHANNEL_TX_TIMEOUT_MS;
      while (Date.now() < fundDeadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await wA.syncWallet();
        req('nodeA.listChannels');
        const channels = (await wA.listChannels()) ?? [];
        res('nodeA.listChannels', { count: channels.length });
        const ch = channels.find(c => c.assetId === assetId && c.fundingTxid != null);
        if (ch) {
          chId           = String(ch.channelId ?? '');
          chFundingTxid  = String(ch.fundingTxid ?? '');
          setChannelId(chId);
          setFundingTxid(chFundingTxid);
          addLog(`Funding tx found: ${chFundingTxid.slice(0, 20)}…`, 'success');
          break;
        }
        await sleep(1000);
      }
      if (!chFundingTxid) throw new Error('Timeout waiting for channel funding tx');

      // ── 14. Confirm channel ────────────────────────────────────────────────
      if (isRegtest) {
        req('mine', { blocks: 6 });
        await mine(6);
        res('mine', { blocks: 6 });
        await sleep(3000);
      }

      addLog('Waiting for channel to become usable on both nodes…');
      const channelUsableTimeout = isRegtest ? CHANNEL_USABLE_TIMEOUT_MS_REGTEST : CHANNEL_USABLE_TIMEOUT_MS_UTEXO;
      for (const [w, label] of [[wA, 'nodeA'], [wB, 'nodeB']] as [UTEXOWallet<'RGB_LN'>, string][]) {
        const deadline = Date.now() + channelUsableTimeout;
        while (Date.now() < deadline) {
          if (abortRef.current) throw new Error('Cancelled');
          req(`${label}.syncWallet`);
          await w.syncWallet();
          res(`${label}.syncWallet`);
          req(`${label}.getNodeInfo`);
          const info = await w.getNodeInfo();
          const usable = Number(info?.numUsableChannels ?? 0);
          res(`${label}.getNodeInfo`, { usableChannels: usable });
          if (label === 'nodeA') setNodeInfoA(info); else setNodeInfoB(info);
          if (usable >= 1) break;
          await sleep(isRegtest ? 2000 : POLL_MS);
        }
      }

      if (isRegtest) {
        req('mine', { blocks: 6 });
        await mine(6);
        res('mine', { blocks: 6 });
      }

      req('nodeA.listChannels');
      const openChannels = (await wA.listChannels()) ?? [];
      res('nodeA.listChannels', {
        count: openChannels.length,
        assetLocal: openChannels[0]?.assetLocalAmount,
        assetRemote: openChannels[0]?.assetRemoteAmount,
      });

      // ── 15. Asset balance before payments ──────────────────────────────────
      setPhase('payments');

      req('nodeA.getAssetBalance', { assetId: assetId.slice(0, 16) + '…' });
      const bal0A = await wA.getAssetBalance(assetId);
      res('nodeA.getAssetBalance', { settled: bal0A?.settled, spendable: bal0A?.spendable });

      req('nodeB.getAssetBalance', { assetId: assetId.slice(0, 16) + '…' });
      const bal0B = await wB.getAssetBalance(assetId);
      res('nodeB.getAssetBalance', { settled: bal0B?.settled, spendable: bal0B?.spendable });

      // ── 16. Payment 1: B creates invoice (100 units), A pays ───────────────
      req('nodeB.createLightningInvoice', { amountSats: 3000, expirySeconds: 900, assetAmount: 100 });
      const inv1 = await wB.createLightningInvoice({ amountSats: 3000, expirySeconds: 900, asset: { assetId, amount: 100 } });
      res('nodeB.createLightningInvoice', { invoice: inv1.lnInvoice.slice(0, 24) + '…' });

      req('nodeA.payLightningInvoice', { assetAmount: 100 });
      const pay1 = await wA.payLightningInvoice({ lnInvoice: inv1.lnInvoice });
      const hash1 = String(pay1?.txid ?? '');
      res('nodeA.payLightningInvoice', { paymentHash: hash1.slice(0, 16) + '…' });

      setPayResults([{ direction: 'A → B', amount: 100, hash: hash1, status: 'Pending' }]);
      const pay1Deadline = Date.now() + PAY_TIMEOUT_MS;
      while (Date.now() < pay1Deadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(2000);
        req('nodeA.getLightningSendStatus', { hash: hash1.slice(0, 16) + '…' });
        await wA.syncWallet();
        const status = await wA.getLightningSendStatus(hash1);
        res('nodeA.getLightningSendStatus', { status });
        setPayResults([{ direction: 'A → B', amount: 100, hash: hash1, status: status ?? 'Pending' }]);
        if (status === 'Succeeded') break;
        if (status === 'Failed') throw new Error('Payment 1 (A→B 100 units) failed');
      }
      addLog('Payment 1 settled: A → B  100 units', 'success');

      // ── 17. Payment 2: A creates invoice (50 units), B pays ────────────────
      req('nodeA.createLightningInvoice', { amountSats: 3000, expirySeconds: 900, assetAmount: 50 });
      const inv2 = await wA.createLightningInvoice({ amountSats: 3000, expirySeconds: 900, asset: { assetId, amount: 50 } });
      res('nodeA.createLightningInvoice', { invoice: inv2.lnInvoice.slice(0, 24) + '…' });

      req('nodeB.payLightningInvoice', { assetAmount: 50 });
      const pay2 = await wB.payLightningInvoice({ lnInvoice: inv2.lnInvoice });
      const hash2 = String(pay2?.txid ?? '');
      res('nodeB.payLightningInvoice', { paymentHash: hash2.slice(0, 16) + '…' });

      setPayResults(prev => [...prev, { direction: 'B → A', amount: 50, hash: hash2, status: 'Pending' }]);
      const pay2Deadline = Date.now() + PAY_TIMEOUT_MS;
      while (Date.now() < pay2Deadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(2000);
        req('nodeB.getLightningSendStatus', { hash: hash2.slice(0, 16) + '…' });
        await wB.syncWallet();
        const status = await wB.getLightningSendStatus(hash2);
        res('nodeB.getLightningSendStatus', { status });
        setPayResults(prev => prev.map((r, i) => i === 1 ? { ...r, status: status ?? 'Pending' } : r));
        if (status === 'Succeeded') break;
        if (status === 'Failed') throw new Error('Payment 2 (B→A 50 units) failed');
      }
      addLog('Payment 2 settled: B → A  50 units', 'success');

      // ── 18. Asset balances after payments ──────────────────────────────────
      req('nodeA.getAssetBalance', { assetId: assetId.slice(0, 16) + '…' });
      const balAfterA = await wA.getAssetBalance(assetId);
      res('nodeA.getAssetBalance', { settled: balAfterA?.settled, spendable: balAfterA?.spendable });

      req('nodeB.getAssetBalance', { assetId: assetId.slice(0, 16) + '…' });
      const balAfterB = await wB.getAssetBalance(assetId);
      res('nodeB.getAssetBalance', { settled: balAfterB?.settled, spendable: balAfterB?.spendable });

      // ── 19. List lightning payments ────────────────────────────────────────
      req('nodeA.listLightningPayments');
      const lnPaymentsA = await wA.listLightningPayments();
      res('nodeA.listLightningPayments', { count: lnPaymentsA?.payments?.length ?? 0 });

      req('nodeB.listLightningPayments');
      const lnPaymentsB = await wB.listLightningPayments();
      res('nodeB.listLightningPayments', { count: lnPaymentsB?.payments?.length ?? 0 });

      // ── 20. Close channel (regtest only) ───────────────────────────────────
      if (isRegtest) {
        req('nodeA.closeChannel', { channelId: chId.slice(0, 16) + '…', force: false });
        await wA.closeChannel(chId, pubkeyB, false);
        res('nodeA.closeChannel');

        req('mine', { blocks: 6 });
        await mine(6);
        res('mine', { blocks: 6 });
        await wA.refreshWallet();
        await wB.refreshWallet();
        await sleep(20000);

        req('mine', { blocks: 6 });
        await mine(6);
        res('mine', { blocks: 6 });
        await wA.refreshWallet();
        await wB.refreshWallet();
        await sleep(10000);
      }

      // ── 21. Final state ────────────────────────────────────────────────────
      req('nodeA.syncWallet');
      await wA.syncWallet();
      res('nodeA.syncWallet');

      req('nodeA.getBtcBalance');
      const finalBalA = await wA.getBtcBalance() as Balance;
      setBalanceA(finalBalA);
      res('nodeA.getBtcBalance', {
        settled: satStr((finalBalA?.vanilla?.settled ?? 0) + (finalBalA?.colored?.settled ?? 0)),
        spendable: satStr((finalBalA?.vanilla?.spendable ?? 0) + (finalBalA?.colored?.spendable ?? 0)),
      });

      req('nodeB.syncWallet');
      await wB.syncWallet();
      res('nodeB.syncWallet');

      req('nodeB.getBtcBalance');
      const finalBalB = await wB.getBtcBalance() as Balance;
      setBalanceB(finalBalB);
      res('nodeB.getBtcBalance', {
        settled: satStr((finalBalB?.vanilla?.settled ?? 0) + (finalBalB?.colored?.settled ?? 0)),
        spendable: satStr((finalBalB?.vanilla?.spendable ?? 0) + (finalBalB?.colored?.spendable ?? 0)),
      });

      req('nodeA.getNodeInfo');
      const finalInfoA = await wA.getNodeInfo();
      setNodeInfoA(finalInfoA);
      res('nodeA.getNodeInfo', { pubkey: String(finalInfoA?.pubkey ?? '').slice(0, 20) + '…', channels: finalInfoA?.numChannels });

      req('nodeB.getNodeInfo');
      const finalInfoB = await wB.getNodeInfo();
      setNodeInfoB(finalInfoB);
      res('nodeB.getNodeInfo', { pubkey: String(finalInfoB?.pubkey ?? '').slice(0, 20) + '…', channels: finalInfoB?.numChannels });

      req('nodeA.listTransactions');
      const txsA = await wA.listTransactions();
      res('nodeA.listTransactions', { count: txsA?.length ?? 0 });

      req('nodeB.listTransactions');
      const txsB = await wB.listTransactions();
      res('nodeB.listTransactions', { count: txsB?.length ?? 0 });

      setAssetBalA(balAfterA);
      setAssetBalB(balAfterB);
      addLog('Flow complete!', 'success');
      setPhase('done');
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      addLog(`Fatal: ${msg}`, 'error');
      setErrorMsg(msg);
      setPhase('error');
    }
  }, [selectedNetwork, addLog]);

  const reset = useCallback(async () => {
    abortRef.current = true;
    for (const ref of [walletARef, walletBRef]) {
      if (ref.current) {
        try { await ref.current.destroy(); } catch {}
        ref.current = null;
      }
    }
    setPhase('idle');
    setLog([]);
    setAddressA(''); setAddressB('');
    setBalanceA(null); setBalanceB(null);
    setNodeInfoA(null); setNodeInfoB(null);
    setAssetInfo(null);
    setChannelId(''); setFundingTxid('');
    setPayResults([]);
    setAssetBalA(null); setAssetBalB(null);
    setErrorMsg('');
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={s.safe} edges={['top', 'left', 'right']}>
      <ScrollView style={s.scroll} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">

        {/* Header */}
        <View style={s.header}>
          <Text style={s.title}>UTEXO 2-Node Flow</Text>
          <Text style={s.subtitle}>Fund → UTXOs → Issue asset → Open channel → Pay → Close</Text>
          <View style={s.networkBadge}>
            <View style={s.networkDot} />
            <Text style={s.networkLabel}>
              {selectedNetwork === 'utexo' ? 'utexo · dev.esplora-01.mint.utexo.com' : `regtest · ${_rpcHost}:18443`}
            </Text>
          </View>
        </View>

        {/* Phase indicator */}
        {phase !== 'idle' && <PhaseBar phase={phase} />}

        {/* Idle */}
        {phase === 'idle' && (
          <View style={s.idleCard}>
            <Text style={s.idleTitle}>Two-Node UTEXO Channel Flow</Text>
            <Text style={s.idleDesc}>
              {selectedNetwork === 'utexo'
                ? '1. Creates Node A and Node B on UTEXO\n2. Generates addresses — you fund BOTH manually\n3. Creates 10 colorable UTXOs on each node\n4. Issues 1000 RGB tokens on Node A\n5. Opens an asset channel A → B (600 tokens pushed)\n6. Two Lightning payments in opposite directions\n7. Shows final asset balances on both nodes'
                : '1. Creates Node A and Node B on local regtest\n2. Auto-funds both via bitcoin node API\n3. Creates 10 colorable UTXOs on each node\n4. Issues 1000 RGB tokens on Node A\n5. Opens an asset channel A → B (600 tokens pushed)\n6. Two Lightning payments in opposite directions\n7. Cooperative channel close\n8. Shows final BTC + asset balances'}
            </Text>

            {/* Network selector */}
            <View style={s.netSelectorWrap}>
              <Text style={s.netSelectorLabel}>Network</Text>
              <View style={s.netSelectorRow}>
                <TouchableOpacity
                  style={[s.netOption, selectedNetwork === 'utexo' && s.netOptionActive]}
                  onPress={() => setSelectedNetwork('utexo')} activeOpacity={0.75}>
                  <Text style={[s.netOptionTxt, selectedNetwork === 'utexo' && s.netOptionTxtActive]}>UTEXO</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.netOption, selectedNetwork === 'regtest' && s.netOptionActive]}
                  onPress={() => setSelectedNetwork('regtest')} activeOpacity={0.75}>
                  <Text style={[s.netOptionTxt, selectedNetwork === 'regtest' && s.netOptionTxtActive]}>Regtest</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={s.credCard}>
              <Text style={s.credTitle}>Connected to</Text>
              {selectedNetwork === 'utexo' ? (
                <>
                  <Text style={s.credLine}>bitcoind  46.224.75.237:38332</Text>
                  <Text style={s.credLine}>indexer   dev.esplora-01.mint.utexo.com</Text>
                  <Text style={s.credLine}>proxy     rgb-proxy-utexo.utexo.com</Text>
                </>
              ) : (
                <>
                  <Text style={s.credLine}>bitcoind  {REGTEST_UNLOCK.bitcoindRpcHost}:{REGTEST_UNLOCK.bitcoindRpcPort}</Text>
                  <Text style={s.credLine}>indexer   {REGTEST_UNLOCK.indexerUrl}</Text>
                  <Text style={s.credLine}>proxy     {REGTEST_UNLOCK.proxyEndpoint}</Text>
                </>
              )}
            </View>

            <TouchableOpacity style={s.startBtn} onPress={start} activeOpacity={0.8}>
              <Text style={s.startBtnTxt}>▶  Start Flow</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Init / UTXOs / any spinner phase */}
        {(phase === 'init' || phase === 'utxos') && (
          <View style={s.spinnerCard}>
            <ActivityIndicator size="large" color={AppColors.primary} />
            <Text style={s.spinnerTxt}>
              {phase === 'init'  ? 'Initializing nodes…' : 'Creating colorable UTXOs on both nodes…'}
            </Text>
          </View>
        )}

        {/* Fund phase — regtest spinner */}
        {phase === 'fund' && activeNetworkRef.current === 'regtest' && (
          <View style={s.spinnerCard}>
            <ActivityIndicator size="large" color={AppColors.primary} />
            <Text style={s.spinnerTxt}>Auto-funding Node A and Node B via regtest API…</Text>
          </View>
        )}

        {/* Fund phase — utexo: show both address cards */}
        {phase === 'fund' && activeNetworkRef.current === 'utexo' && (
          <>
            <NodeFundCard label="Node A" address={addressA} balance={balanceA} />
            <NodeFundCard label="Node B" address={addressB} balance={balanceB} />
          </>
        )}

        {/* Channel phase */}
        {phase === 'channel' && (
          <ChannelCard channelId={channelId} fundingTxid={fundingTxid} assetId={assetInfo?.assetId ?? ''} network={activeNetworkRef.current} />
        )}

        {/* Payments phase */}
        {phase === 'payments' && (
          <PaymentsCard results={payResults} />
        )}

        {/* Done */}
        {phase === 'done' && (
          <DoneCard
            nodeInfoA={nodeInfoA} nodeInfoB={nodeInfoB}
            balanceA={balanceA}   balanceB={balanceB}
            assetInfo={assetInfo}
            assetBalA={assetBalA} assetBalB={assetBalB}
            payResults={payResults}
            channelId={channelId}
          />
        )}

        {/* Error */}
        {phase === 'error' && (
          <View style={s.errorCard}>
            <Text style={s.errorTitle}>Flow failed</Text>
            <Text style={s.errorMsg}>{errorMsg}</Text>
          </View>
        )}

        {/* Re-run / Reset */}
        {(phase === 'done' || phase === 'error') && (
          <TouchableOpacity style={s.resetBtn} onPress={reset} activeOpacity={0.8}>
            <Text style={s.resetBtnTxt}>↺  Reset</Text>
          </TouchableOpacity>
        )}

        {/* Cancel while running */}
        {(phase === 'fund' || phase === 'utxos' || phase === 'channel' || phase === 'payments') && (
          <TouchableOpacity style={s.cancelBtn} onPress={reset} activeOpacity={0.8}>
            <Text style={s.cancelBtnTxt}>✕  Cancel</Text>
          </TouchableOpacity>
        )}

        {/* Log pane */}
        {log.length > 0 && <LogPane entries={log} />}

      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: AppColors.bgBase },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 60 },
  header: { marginBottom: 20 },
  title: { fontSize: 22, fontWeight: '700', color: AppColors.textPrimary, letterSpacing: -0.3 },
  subtitle: { fontSize: 13, color: AppColors.textSecondary, marginTop: 2 },
  networkBadge: { flexDirection: 'row', alignItems: 'center', marginTop: 8, backgroundColor: AppColors.bgCard, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, alignSelf: 'flex-start', borderWidth: 1, borderColor: AppColors.border },
  networkDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: AppColors.success, marginRight: 6 },
  networkLabel: { fontSize: 11, color: AppColors.textSecondary, fontFamily: AppColors.mono },
  idleCard: { backgroundColor: AppColors.bgCard, borderRadius: 12, padding: 20, borderWidth: 1, borderColor: AppColors.border, marginBottom: 16 },
  idleTitle: { fontSize: 16, fontWeight: '700', color: AppColors.textPrimary, marginBottom: 8 },
  idleDesc: { fontSize: 13, color: AppColors.textSecondary, lineHeight: 22, marginBottom: 16 },
  credCard: { backgroundColor: AppColors.bgCardElevated, borderRadius: 8, padding: 12, marginBottom: 16 },
  credTitle: { fontSize: 11, color: AppColors.textTertiary, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 },
  credLine: { fontSize: 12, color: AppColors.textSecondary, fontFamily: AppColors.mono, marginBottom: 2 },
  startBtn: { backgroundColor: AppColors.primary, borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  startBtnTxt: { fontSize: 15, fontWeight: '700', color: AppColors.black },
  spinnerCard: { backgroundColor: AppColors.bgCard, borderRadius: 12, padding: 32, alignItems: 'center', borderWidth: 1, borderColor: AppColors.border, marginBottom: 16 },
  spinnerTxt: { fontSize: 14, color: AppColors.textSecondary, marginTop: 14, textAlign: 'center' },
  errorCard: { backgroundColor: AppColors.errorBg, borderRadius: 12, padding: 20, borderWidth: 1, borderColor: AppColors.errorBorder, marginBottom: 16 },
  errorTitle: { fontSize: 15, fontWeight: '700', color: AppColors.error, marginBottom: 8 },
  errorMsg: { fontSize: 13, color: '#FCA5A5', lineHeight: 18 },
  resetBtn: { borderWidth: 1, borderColor: AppColors.primary, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginBottom: 16 },
  resetBtnTxt: { fontSize: 14, fontWeight: '600', color: AppColors.primary },
  cancelBtn: { borderWidth: 1, borderColor: AppColors.error, borderRadius: 10, paddingVertical: 10, alignItems: 'center', marginBottom: 16 },
  cancelBtnTxt: { fontSize: 13, color: AppColors.error },
  netSelectorWrap: { marginBottom: 14 },
  netSelectorLabel: { fontSize: 11, color: AppColors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 },
  netSelectorRow: { flexDirection: 'row', borderRadius: 8, borderWidth: 1, borderColor: AppColors.border, overflow: 'hidden' },
  netOption: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: AppColors.bgBase },
  netOptionActive: { backgroundColor: AppColors.primary },
  netOptionTxt: { fontSize: 13, fontWeight: '600', color: AppColors.textSecondary },
  netOptionTxtActive: { color: AppColors.black },
});

const pb = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, backgroundColor: AppColors.bgCard, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: AppColors.border },
  step: { alignItems: 'center', flex: 0 },
  dot: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginBottom: 3 },
  dotText: { fontSize: 9, fontWeight: '700' },
  label: { fontSize: 8, fontWeight: '600', letterSpacing: 0.3 },
  line: { flex: 1, height: 2, marginBottom: 12, marginHorizontal: 2 },
});

const nf = StyleSheet.create({
  card: { backgroundColor: AppColors.bgCard, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: AppColors.primary + '40', marginBottom: 12 },
  label: { fontSize: 12, fontWeight: '700', color: AppColors.primary, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.8 },
  addrBox: { backgroundColor: AppColors.bgBase, borderRadius: 8, padding: 10, borderWidth: 1, borderColor: AppColors.border, marginBottom: 10 },
  addr: { fontSize: 11, color: AppColors.textAccent, fontFamily: AppColors.mono, lineHeight: 18 },
  balRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  balItem: { flex: 1, alignItems: 'center' },
  balKey: { fontSize: 10, color: AppColors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
  balVal: { fontSize: 12, fontWeight: '600', color: AppColors.textSecondary },
  balDivider: { width: 1, backgroundColor: AppColors.border },
  badge: { flexDirection: 'row', alignItems: 'center', borderRadius: 8, padding: 8, backgroundColor: AppColors.bgCardElevated },
  badgeTxt: { fontSize: 11, color: AppColors.textTertiary },
});

const ch = StyleSheet.create({
  card: { backgroundColor: AppColors.bgCard, borderRadius: 12, padding: 24, borderWidth: 1, borderColor: AppColors.border, alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 15, fontWeight: '700', color: AppColors.textPrimary, marginBottom: 12 },
  line: { fontSize: 12, color: AppColors.textSecondary, fontFamily: AppColors.mono, marginBottom: 4 },
  sub: { fontSize: 12, color: AppColors.textTertiary, marginTop: 8, textAlign: 'center' },
});

const pm = StyleSheet.create({
  card: { backgroundColor: AppColors.bgCard, borderRadius: 12, padding: 20, borderWidth: 1, borderColor: AppColors.border, marginBottom: 16 },
  title: { fontSize: 15, fontWeight: '700', color: AppColors.textPrimary, marginBottom: 14 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderTopWidth: 1, borderTopColor: AppColors.border },
  dir: { fontSize: 13, color: AppColors.textSecondary, flex: 1 },
  amount: { fontSize: 13, fontWeight: '600', color: AppColors.textPrimary, flex: 1, textAlign: 'center' },
  status: { fontSize: 12, fontWeight: '600', color: AppColors.textTertiary, flex: 1, textAlign: 'right' },
});

const dc = StyleSheet.create({
  card: { backgroundColor: AppColors.bgCard, borderRadius: 12, padding: 20, borderWidth: 1, borderColor: AppColors.successBorder, marginBottom: 16 },
  badge: { fontSize: 13, fontWeight: '700', color: AppColors.success, marginBottom: 16 },
  section: { marginBottom: 14 },
  sectionTitle: { fontSize: 11, color: AppColors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 6 },
  mono: { fontSize: 11, color: AppColors.textAccent, fontFamily: AppColors.mono, lineHeight: 18 },
  detail: { fontSize: 12, color: AppColors.textSecondary, marginTop: 4, lineHeight: 18 },
});

const lp = StyleSheet.create({
  box: { backgroundColor: AppColors.bgCard, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: AppColors.border, marginTop: 8 },
  header: { fontSize: 11, color: AppColors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 },
  empty: { fontSize: 12, color: AppColors.textTertiary, fontStyle: 'italic' },
  entry: { fontSize: 11, color: AppColors.textSecondary, fontFamily: AppColors.mono, lineHeight: 18 },
});
