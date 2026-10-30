/**
 * On-device mirror of test_virtual_channel_asset_payment_succeeds.
 *
 * Two embedded SDK nodes open a VIRTUAL RGB channel directly (no LSP).
 * Node A issues the asset, connects to Node B, opens the channel, then
 * sends a payment A→B and a reverse payment B→A proving bidirectional flow.
 *
 * Node B is created with virtualPeerPubkeys=[pkA] so it accepts Node A's
 * virtual channel open — mirroring the Python test exactly.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';
import { useCallback, useRef, useState } from 'react';

import { mine, sendToAddress } from '@/utils/wallet-flow';
import { createWallet, PasswordRLNSigner, UTEXOWallet } from '@utexo/rgb-sdk-rn';

import {
  CHANNEL_ASSET_AMOUNT, CHANNEL_CAPACITY_SAT, CHANNEL_CLOSE_TIMEOUT_S, CHANNEL_TIMEOUT_S,
  CLIENT_OPEN_CAPACITY_SAT, CLIENT_OPEN_TIMEOUT_S,
  PAYMENT_ASSET_AMOUNT, PAYMENT_MSAT, PAYMENT_TIMEOUT_S, POLL_INTERVAL_S,
  VIRTUAL_OPEN_MODE, REGTEST_UNLOCK, sleep, short, satStr,
  type LogEntry, type Phase, type ReopenOutcome, type AcceptOutcome,
} from './config';

export function useVirtualChannelFlow() {
  const [phase,     setPhase]     = useState<Phase>('idle');
  const [log,       setLog]       = useState<LogEntry[]>([]);
  const [pubkeyA,   setPubkeyA]   = useState('');
  const [pubkeyB,   setPubkeyB]   = useState('');
  const [addrA,     setAddrA]     = useState('');
  const [addrB,     setAddrB]     = useState('');
  const [assetId,   setAssetId]   = useState('');
  const [chanA,     setChanA]     = useState<any>(null);
  const [chanB,     setChanB]     = useState<any>(null);
  const [invoiceAB, setInvoiceAB] = useState('');
  const [invoiceBA, setInvoiceBA] = useState('');
  const [statusAB,  setStatusAB]  = useState('');
  const [statusBA,  setStatusBA]  = useState('');
  const [balA,      setBalA]      = useState<any>(null);
  const [balB,      setBalB]      = useState<any>(null);
  const [errorMsg,  setErrorMsg]  = useState('');
  const [closeConfirmed, setCloseConfirmed] = useState(false);
  const [reopenOutcome,  setReopenOutcome]  = useState<ReopenOutcome>('pending');
  const [reopenErrorMsg, setReopenErrorMsg] = useState('');
  const [reopenChanId,   setReopenChanId]   = useState('');
  const [btcChannelOutcome, setBtcChannelOutcome] = useState<ReopenOutcome>('pending');
  const [btcChannelError,  setBtcChannelError]  = useState('');
  const [btcChannelId,     setBtcChannelId]     = useState('');
  const [pubkeyC,          setPubkeyC]          = useState('');
  const [clientOpenOutcome, setClientOpenOutcome] = useState<AcceptOutcome>('pending');
  const [clientOpenError,   setClientOpenError]   = useState('');
  const [clientOpenChanId,  setClientOpenChanId]  = useState('');

  const walletARef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const walletBRef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const walletCRef = useRef<UTEXOWallet<'RGB_LN'> | null>(null);
  const abortRef   = useRef(false);

  const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString('en', { hour12: false });
    setLog(prev => [...prev.slice(-500), { time, msg, type }]);
    console.log(`[vc][${type}] ${msg}`);
  }, []);

  const run = useCallback(async () => {
    abortRef.current = false;
    setLog([]); setPubkeyA(''); setPubkeyB(''); setAddrA(''); setAddrB('');
    setAssetId(''); setChanA(null); setChanB(null);
    setInvoiceAB(''); setInvoiceBA(''); setStatusAB(''); setStatusBA('');
    setBalA(null); setBalB(null); setErrorMsg('');
    setCloseConfirmed(false); setReopenOutcome('pending'); setReopenErrorMsg(''); setReopenChanId('');
    setBtcChannelOutcome('pending'); setBtcChannelError(''); setBtcChannelId('');
    setPubkeyC(''); setClientOpenOutcome('pending'); setClientOpenError(''); setClientOpenChanId('');

    const req = (label: string, p?: Record<string, any>) =>
      addLog(`→ ${label}${p ? '  ' + Object.entries(p).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`);
    const res = (label: string, d?: Record<string, any>) =>
      addLog(`← ${label}${d ? '  ' + Object.entries(d).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`, 'success');

    try {
      // ── Init Node A ──────────────────────────────────────────────────────────
      setPhase('init');

      req('createWallet nodeA');
      const keysA = await createWallet('regtest' as any);
      res('createWallet nodeA', { fp: keysA.masterFingerprint });

      const ts    = Date.now();
      const portA = 38000 + Math.floor(Math.random() * 1000);
      const dirAUri = `${documentDirectory ?? ''}vc_na_${ts}`;
      await FileSystem.makeDirectoryAsync(dirAUri, { intermediates: true });
      addLog(`nodeA storage: ${dirAUri.replace('file://', '')}`);

      const wA = new UTEXOWallet(
        { storageDirPath: dirAUri.replace('file://', ''), daemonListeningPort: portA,
          ldkPeerListeningPort: portA + 1, network: 'regtest',
          enableVirtualChannelsV0: true },
        new PasswordRLNSigner('vcpass_a', keysA.mnemonic),
      );
      walletARef.current = wA;
      await wA.init();
      await wA.unlock(REGTEST_UNLOCK);

      const infoA = await wA.getNodeInfo();
      const pkA = String(infoA.pubkey ?? '');
      setPubkeyA(pkA);
      res('nodeA.init+unlock', { pubkey: short(pkA, 20) });

      req('nodeA.getAddress');
      const addressA = await wA.getAddress();
      setAddrA(addressA);
      res('nodeA.getAddress', { address: addressA });

      // ── Init Node B ──────────────────────────────────────────────────────────
      setPhase('init_b');

      req('createWallet nodeB');
      const keysB = await createWallet('regtest' as any);
      res('createWallet nodeB', { fp: keysB.masterFingerprint });

      // Port offset +200 keeps A and B well apart
      const portB   = portA + 200;
      const dirBUri = `${documentDirectory ?? ''}vc_nb_${ts}`;
      await FileSystem.makeDirectoryAsync(dirBUri, { intermediates: true });
      addLog(`nodeB storage: ${dirBUri.replace('file://', '')}`);

      const wB = new UTEXOWallet(
        { storageDirPath: dirBUri.replace('file://', ''), daemonListeningPort: portB,
          ldkPeerListeningPort: portB + 1, network: 'regtest',
          enableVirtualChannelsV0: true,
          virtualPeerPubkeys: pkA ? [pkA] : null },
        new PasswordRLNSigner('vcpass_b', keysB.mnemonic),
      );
      walletBRef.current = wB;
      await wB.init();
      await wB.unlock(REGTEST_UNLOCK);

      const infoB = await wB.getNodeInfo();
      const pkB = String(infoB.pubkey ?? '');
      setPubkeyB(pkB);
      res('nodeB.init+unlock', { pubkey: short(pkB, 20) });

      req('nodeB.getAddress');
      const addressB = await wB.getAddress();
      setAddrB(addressB);
      res('nodeB.getAddress', { address: addressB });

      // ── Fund both nodes ──────────────────────────────────────────────────────
      setPhase('fund');

      addLog('Funding both nodes (1 BTC each) …');
      await sendToAddress(addressA, 1);
      await sendToAddress(addressB, 1);
      await mine(6);
      await sleep(3000);
      await wA.syncWallet();
      await wB.syncWallet();

      const btcBal = await wA.getBtcBalance() as any;
      const spA = (btcBal?.vanilla?.spendable ?? 0) + (btcBal?.colored?.spendable ?? 0);
      addLog(`nodeA BTC spendable: ${satStr(spA)}`, 'success');

      req('nodeA.createUtxos');
      await wA.createUtxos({ upTo: false, num: 10, feeRate: 7 });
      req('nodeB.createUtxos');
      await wB.createUtxos({ upTo: false, num: 10, feeRate: 7 });
      await mine(1);
      await wA.syncWallet();
      await wB.syncWallet();
      res('createUtxos nodeA+B');

      // ── Node A issues RGB asset ──────────────────────────────────────────────
      setPhase('issue');

      req('nodeA.refreshWallet');
      await wA.refreshWallet();
      res('nodeA.refreshWallet');

      req('nodeA.issueAssetNia', { ticker: 'VTST', supply: 1000 });
      const asset = await wA.issueAssetNia({ ticker: 'VTST', name: 'Virtual Test', precision: 0, amounts: [1000] });
      const aid = asset.assetId;
      setAssetId(aid);
      res('nodeA.issueAssetNia', { assetId: short(aid, 20) });

      await mine(1);
      await wA.syncWallet();

      // Poll until Node A sees settled asset balance
      const issueDeadline = Date.now() + 30_000;
      while (Date.now() < issueDeadline) {
        if (abortRef.current) throw new Error('Cancelled');
        const ab = await wA.getAssetBalance(aid);
        if ((ab?.settled ?? 0) > 0) {
          addLog(`nodeA asset settled: ${ab.settled} VTST ✓`, 'success');
          break;
        }
        await sleep(2000);
        await wA.syncWallet();
      }

      // ── Connect peers ────────────────────────────────────────────────────────
      setPhase('connect');

      // Intra-device connection always uses 127.0.0.1 regardless of platform.
      const peerUri = `${pkB}@127.0.0.1:${portB + 1}`;
      req('nodeA.connectPeer', { uri: short(peerUri, 30) });
      await wA.connectPeer(peerUri);
      await sleep(2000);
      res('nodeA.connectPeer');

      // ── Open virtual RGB channel ─────────────────────────────────────────────
      setPhase('open_channel');

      req('nodeA.openChannel', { capacitySat: CHANNEL_CAPACITY_SAT, assetAmount: CHANNEL_ASSET_AMOUNT, virtualOpenMode: VIRTUAL_OPEN_MODE });
      const openResp = await wA.openChannel({
        peerPubkey: peerUri,
        capacitySat: CHANNEL_CAPACITY_SAT,
        pushMsat: 0,
        isPublic: false,
        withAnchors: true,
        assetId: aid,
        assetLocalAmount: CHANNEL_ASSET_AMOUNT,
        pushAssetAmount: null,
        virtualOpenMode: VIRTUAL_OPEN_MODE,
      });
      res('nodeA.openChannel', { tmpChanId: short(openResp.temporaryChannelId, 16) });

      // ── Wait for channel usable on both nodes ────────────────────────────────
      setPhase('wait_channel');

      addLog(`Waiting for virtual RGB channel (timeout ${CHANNEL_TIMEOUT_S}s) …`);
      const chanDeadline = Date.now() + CHANNEL_TIMEOUT_S * 1000;
      let nodeAChan: any = null;
      let nodeBChan: any = null;
      while (Date.now() < chanDeadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await mine(1);
        await sleep(POLL_INTERVAL_S * 1000);
        try {
          const chansA = (await wA.listChannels()) ?? [];
          nodeAChan = (chansA as any[]).find(c => c.assetId === aid && (c.isUsable === true || c.is_usable === true)) ?? null;
          const chansB = (await wB.listChannels()) ?? [];
          nodeBChan = (chansB as any[]).find(c => c.assetId === aid && (c.isUsable === true || c.is_usable === true)) ?? null;
          addLog(`nodeA: ${nodeAChan ? 'usable ✓' : 'waiting…'}  nodeB: ${nodeBChan ? 'visible ✓' : 'waiting…'}`);
          if (nodeAChan && nodeBChan) break;
        } catch (e: any) {
          addLog(`listChannels: ${e?.message ?? e}`, 'error');
        }
      }

      if (!nodeAChan) throw new Error(`Timed out waiting for Node A virtual RGB channel after ${CHANNEL_TIMEOUT_S}s`);
      setChanA(nodeAChan);
      if (nodeBChan) setChanB(nodeBChan);
      else addLog('Node B channel not yet visible — continuing', 'info');
      addLog(`Channel open ✓  mode=${nodeAChan.virtualOpenMode ?? 'default'}  localAsset=${nodeAChan.assetLocalAmount ?? '?'}`, 'success');

      // ── Second virtual channel attempt — BTC-only, same peer ─────────────────
      // virtual_channel_add_intent() (ldk.rs:777-802) caps virtual sessions at ONE per peer_id,
      // asset-agnostic — the RGB channel above already occupies that slot, so this is expected
      // to be rejected the same way a same-asset reopen would be.
      setPhase('open_btc_channel');

      addLog('Attempting a 2nd virtual channel to the same peer (BTC-only, no assetId) — expect rejection: one virtual channel per peer pair, regardless of asset.');
      req('nodeA.openChannel (BTC-only, same peer)', { capacitySat: CHANNEL_CAPACITY_SAT, virtualOpenMode: VIRTUAL_OPEN_MODE });
      try {
        const btcOpenResp = await wA.openChannel({
          peerPubkey: peerUri,
          capacitySat: CHANNEL_CAPACITY_SAT,
          pushMsat: 0,
          isPublic: false,
          withAnchors: true,
          virtualOpenMode: VIRTUAL_OPEN_MODE,
        });
        const btcTmpId = String(btcOpenResp?.temporaryChannelId ?? '');
        setBtcChannelOutcome('succeeded');
        setBtcChannelId(btcTmpId);
        res('nodeA.openChannel (BTC-only)', { tmpChanId: short(btcTmpId, 16) });
        addLog('⚠ BTC-only channel opened successfully — one-virtual-channel-per-peer limit did not apply here (unexpected)', 'success');
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        setBtcChannelError(msg);
        if (msg.toLowerCase().includes('already exists for this peer pair')) {
          setBtcChannelOutcome('blocked');
          addLog(`Confirmed: BTC-only open rejected — "${msg}" (one virtual channel per peer, regardless of asset — ldk.rs:793-802)`, 'success');
        } else {
          setBtcChannelOutcome('error');
          addLog(`BTC-only open failed with an unexpected error: ${msg}`, 'error');
        }
      }

      // ── Snapshot initial offchain balances ───────────────────────────────────
      await wA.syncWallet(); await wB.syncWallet();
      const initBalA = await wA.getAssetBalance(aid);
      const initBalB = await wB.getAssetBalance(aid);
      addLog(`initial offchain: nodeA outbound=${initBalA?.offchainOutbound ?? 'n/a'}  nodeB outbound=${initBalB?.offchainOutbound ?? 'n/a'}`);

      // ── Part 1: A → B payment ────────────────────────────────────────────────
      setPhase('pay_ab');

      req('nodeB.createLightningInvoice', { msat: PAYMENT_MSAT, assetAmount: PAYMENT_ASSET_AMOUNT });
      const invAB = await wB.createLightningInvoice({
        amountSats: PAYMENT_MSAT / 1000,
        expirySeconds: 3600,
        asset: { assetId: aid, amount: PAYMENT_ASSET_AMOUNT },
      });
      const invoiceABStr = invAB.lnInvoice;
      setInvoiceAB(invoiceABStr);
      res('nodeB.createLightningInvoice', { invoice: short(invoiceABStr, 28) });

      req('nodeA.payLightningInvoice → nodeB');
      const payAB = await wA.payLightningInvoice({ lnInvoice: invoiceABStr });
      const payABStatus = String((payAB as any)?.status ?? '').toUpperCase();
      res('nodeA.payLightningInvoice', { status: (payAB as any)?.status ?? 'sent' });
      if (payABStatus === 'FAILED') throw new Error('nodeA.payLightningInvoice A→B failed immediately — check channel balance and route');

      // ── Wait for A→B settlement ──────────────────────────────────────────────
      setPhase('settle_ab');
      setStatusAB('Pending');

      addLog('Waiting for A→B invoice to settle …');
      const deadlineAB = Date.now() + PAYMENT_TIMEOUT_S * 1000;
      let settledAB = false;
      while (Date.now() < deadlineAB) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(POLL_INTERVAL_S * 1000);
        await wA.syncWallet(); await wB.syncWallet();
        try {
          const st = String(await wB.invoiceStatus(invoiceABStr) ?? 'Pending');
          setStatusAB(st);
          addLog(`A→B invoice: ${st}`);
          if (st === 'Succeeded') { settledAB = true; break; }
          if (st === 'Failed' || st === 'Cancelled') throw new Error(`A→B invoice ${st}`);
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          if (msg.includes('Failed') || msg.includes('Cancelled')) throw e;
          addLog(`invoiceStatus error: ${msg}`);
        }
      }
      if (!settledAB) addLog('A→B settlement timeout — invoice may still be processing', 'info');
      else addLog('A→B payment Succeeded ✓', 'success');

      const afterABbalA = await wA.getAssetBalance(aid);
      const afterABbalB = await wB.getAssetBalance(aid);
      setBalA(afterABbalA); setBalB(afterABbalB);
      addLog(`offchain after A→B: nodeA outbound=${afterABbalA?.offchainOutbound ?? 'n/a'}  nodeB outbound=${afterABbalB?.offchainOutbound ?? 'n/a'}`);
      const aOutAfterAB = afterABbalA?.offchainOutbound;
      const bOutAfterAB = afterABbalB?.offchainOutbound;
      if (aOutAfterAB != null && initBalA?.offchainOutbound != null) {
        const delta = (initBalA.offchainOutbound - aOutAfterAB);
        if (delta === PAYMENT_ASSET_AMOUNT) addLog(`nodeA outbound decreased by ${PAYMENT_ASSET_AMOUNT} ✓`, 'success');
      }
      if (bOutAfterAB != null && initBalB?.offchainOutbound != null) {
        const delta = (bOutAfterAB - initBalB.offchainOutbound);
        if (delta === PAYMENT_ASSET_AMOUNT) addLog(`nodeB outbound increased by ${PAYMENT_ASSET_AMOUNT} ✓`, 'success');
      }

      // ── Part 2: B → A reverse payment ────────────────────────────────────────
      setPhase('pay_ba');

      req('nodeA.createLightningInvoice (reverse)', { msat: PAYMENT_MSAT, assetAmount: PAYMENT_ASSET_AMOUNT });
      const invBA = await wA.createLightningInvoice({
        amountSats: PAYMENT_MSAT / 1000,
        expirySeconds: 3600,
        asset: { assetId: aid, amount: PAYMENT_ASSET_AMOUNT },
      });
      const invoiceBAStr = invBA.lnInvoice;
      setInvoiceBA(invoiceBAStr);
      res('nodeA.createLightningInvoice', { invoice: short(invoiceBAStr, 28) });

      req('nodeB.payLightningInvoice → nodeA');
      const payBA = await wB.payLightningInvoice({ lnInvoice: invoiceBAStr });
      const payBAStatus = String((payBA as any)?.status ?? '').toUpperCase();
      res('nodeB.payLightningInvoice', { status: (payBA as any)?.status ?? 'sent' });
      if (payBAStatus === 'FAILED') throw new Error('nodeB.payLightningInvoice B→A failed immediately — check channel balance and route');

      // ── Wait for B→A settlement ──────────────────────────────────────────────
      setPhase('settle_ba');
      setStatusBA('Pending');

      addLog('Waiting for B→A reverse invoice to settle …');
      const deadlineBA = Date.now() + PAYMENT_TIMEOUT_S * 1000;
      let settledBA = false;
      while (Date.now() < deadlineBA) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(POLL_INTERVAL_S * 1000);
        await wA.syncWallet(); await wB.syncWallet();
        try {
          const st = String(await wA.invoiceStatus(invoiceBAStr) ?? 'Pending');
          setStatusBA(st);
          addLog(`B→A invoice: ${st}`);
          if (st === 'Succeeded') { settledBA = true; break; }
          if (st === 'Failed' || st === 'Cancelled') throw new Error(`B→A invoice ${st}`);
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          if (msg.includes('Failed') || msg.includes('Cancelled')) throw e;
          addLog(`invoiceStatus error: ${msg}`);
        }
      }
      if (!settledBA) addLog('B→A settlement timeout — invoice may still be processing', 'info');
      else addLog('B→A reverse payment Succeeded ✓', 'success');

      // Final balance — check balances restored to initial
      const finalBalA = await wA.getAssetBalance(aid);
      const finalBalB = await wB.getAssetBalance(aid);
      setBalA(finalBalA); setBalB(finalBalB);
      addLog(`final offchain: nodeA outbound=${finalBalA?.offchainOutbound ?? 'n/a'}  nodeB outbound=${finalBalB?.offchainOutbound ?? 'n/a'}`);
      if (finalBalA?.offchainOutbound != null && finalBalA.offchainOutbound === initBalA?.offchainOutbound) {
        addLog('nodeA offchain balance restored to initial ✓', 'success');
      }
      if (finalBalB?.offchainOutbound != null && finalBalB.offchainOutbound === initBalB?.offchainOutbound) {
        addLog('nodeB offchain balance restored to initial ✓', 'success');
      }

      // ── Cooperative close (repro: issue-virtual-session-leak.md) ────────────
      setPhase('close_channel');

      const channelId = String(nodeAChan?.channelId ?? nodeAChan?.channel_id ?? '');
      if (!channelId) throw new Error('Could not resolve channelId for close');

      // Pre-check: rgb-lightning-node's virtual_channel_ensure_no_client_value() (ldk.rs:864-943)
      // rejects the close unless the COUNTERPARTY's balance is exactly zero, both BTC and asset —
      // it does not care about our own balance. Verify that here instead of finding out from a
      // "counterparty BTC balance floor is N sat" error at close time, which would otherwise be
      // indistinguishable from a real close failure in this repro.
      addLog('Checking counterparty (nodeB) balance before close — must be exactly zero …');
      await wA.syncWallet().catch(() => {});
      const preCloseChans = (await wA.listChannels()) ?? [];
      const preCloseChan = (preCloseChans as any[]).find(c => (c.channelId ?? c.channel_id) === channelId);
      const remoteBalanceMsat = Number(preCloseChan?.remoteBalanceMsat ?? preCloseChan?.remote_balance_msat ?? NaN);
      const assetRemoteAmount = Number(preCloseChan?.assetRemoteAmount ?? preCloseChan?.asset_remote_amount ?? NaN);
      addLog(`nodeB balance as seen by nodeA: ${Number.isFinite(remoteBalanceMsat) ? remoteBalanceMsat + ' msat' : 'n/a'}  ${Number.isFinite(assetRemoteAmount) ? assetRemoteAmount + ' VTST' : 'n/a'}`);
      if (Number.isFinite(remoteBalanceMsat) && remoteBalanceMsat !== 0) {
        throw new Error(`Close would be rejected: counterparty BTC balance is ${remoteBalanceMsat} msat, not 0 (virtual_channel_ensure_no_client_value requires counterparty_balance_sats_floor == 0). The A→B/B→A round trip did not fully return value to nodeA.`);
      }
      if (Number.isFinite(assetRemoteAmount) && assetRemoteAmount !== 0) {
        throw new Error(`Close would be rejected: counterparty asset balance is ${assetRemoteAmount} VTST, not 0 (virtual_channel_ensure_no_client_value requires remote_rgb_amount == 0).`);
      }
      addLog('Counterparty balance confirmed zero ✓ — close should be accepted', 'success');

      req('nodeA.closeChannel (cooperative)', { channelId: short(channelId, 16), force: false });
      await wA.closeChannel(channelId, pkB, false);
      res('nodeA.closeChannel', { channelId: short(channelId, 16) });

      addLog(`Confirming channel is actually gone (timeout ${CHANNEL_CLOSE_TIMEOUT_S}s) …`);
      const closeDeadline = Date.now() + CHANNEL_CLOSE_TIMEOUT_S * 1000;
      let goneFromA = false;
      let goneFromB = false;
      while (Date.now() < closeDeadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await sleep(POLL_INTERVAL_S * 1000);
        await wA.syncWallet().catch(() => {});
        await wB.syncWallet().catch(() => {});
        try {
          const chansA = (await wA.listChannels()) ?? [];
          const chansB = (await wB.listChannels()) ?? [];
          goneFromA = !(chansA as any[]).some(c => (c.channelId ?? c.channel_id) === channelId);
          goneFromB = !(chansB as any[]).some(c => (c.channelId ?? c.channel_id) === channelId);
          addLog(`nodeA: ${goneFromA ? 'gone ✓' : 'still listed…'}  nodeB: ${goneFromB ? 'gone ✓' : 'still listed…'}`);
          if (goneFromA && goneFromB) break;
        } catch (e: any) {
          addLog(`listChannels: ${e?.message ?? e}`, 'error');
        }
      }

      if (!goneFromA) throw new Error(`Channel still listed on nodeA after ${CHANNEL_CLOSE_TIMEOUT_S}s — cooperative close did not complete, cannot proceed to reopen repro`);
      setCloseConfirmed(goneFromB);
      if (goneFromB) {
        addLog(`Channel confirmed closed on both nodes ✓ (verified via listChannels, not just the closeChannel() return)`, 'success');
      } else {
        addLog(`Channel gone from nodeA but STILL LISTED on nodeB after ${CHANNEL_CLOSE_TIMEOUT_S}s — the peer was never notified of the close (abandon_virtual_channel() uses ErrorAction::IgnoreError). Proceeding to reopen repro from nodeA's side anyway.`, 'error');
      }

      // ── Reopen attempt — expect the session-leak bug to block this ──────────
      setPhase('reopen_attempt');

      req('nodeA.openChannel (2nd attempt, same peer)', { capacitySat: CHANNEL_CAPACITY_SAT, assetAmount: CHANNEL_ASSET_AMOUNT, virtualOpenMode: VIRTUAL_OPEN_MODE });
      try {
        const reopenResp = await wA.openChannel({
          peerPubkey: peerUri,
          capacitySat: CHANNEL_CAPACITY_SAT,
          pushMsat: 0,
          isPublic: false,
          withAnchors: true,
          assetId: aid,
          assetLocalAmount: CHANNEL_ASSET_AMOUNT,
          pushAssetAmount: null,
          virtualOpenMode: VIRTUAL_OPEN_MODE,
        });
        const newTmpId = String(reopenResp?.temporaryChannelId ?? '');
        setReopenChanId(newTmpId);
        setReopenOutcome('succeeded');
        res('nodeA.openChannel (reopen)', { tmpChanId: short(newTmpId, 16) });
        addLog('⚠ Reopen SUCCEEDED — session-leak bug does not reproduce on this build (may already be fixed)', 'success');
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        setReopenErrorMsg(msg);
        if (msg.toLowerCase().includes('virtual channel session already exists')) {
          setReopenOutcome('blocked');
          addLog(`🐛 REPRODUCED — reopen rejected: "${msg}" (see docs/issue-virtual-session-leak.md)`, 'success');
        } else {
          setReopenOutcome('error');
          addLog(`Reopen failed with an unexpected error (not the session-leak signature): ${msg}`, 'error');
        }
      }

      // ── Accept-mode asymmetry — fresh Node C tries a REGULAR open to Node B ──
      // Node B has enableVirtualChannelsV0=true + virtualPeerPubkeys=[pkA] (only trusts A for
      // virtual). Node C is a plain node with no virtual flags, requesting an ordinary channel.
      // Per docs/issue-virtual-channel-accept-mode.md: Node B's acceptor branches on its OWN
      // enableVirtualChannelsV0 flag before looking at what the incoming request actually asked
      // for — so this plain request may get swept into the "untrusted_virtual_peer" rejection
      // meant for virtual opens, even though Node C never requested virtual_open_mode at all.
      setPhase('client_regular_open');

      req('createWallet nodeC (plain client, no virtual flags)');
      const keysC = await createWallet('regtest' as any);
      res('createWallet nodeC', { fp: keysC.masterFingerprint });

      const portC   = portA + 400;
      const dirCUri = `${documentDirectory ?? ''}vc_nc_${ts}`;
      await FileSystem.makeDirectoryAsync(dirCUri, { intermediates: true });
      addLog(`nodeC storage: ${dirCUri.replace('file://', '')}`);

      const wC = new UTEXOWallet(
        { storageDirPath: dirCUri.replace('file://', ''), daemonListeningPort: portC,
          ldkPeerListeningPort: portC + 1, network: 'regtest' },
        new PasswordRLNSigner('vcpass_c', keysC.mnemonic),
      );
      walletCRef.current = wC;
      await wC.init();
      await wC.unlock(REGTEST_UNLOCK);

      const infoC = await wC.getNodeInfo();
      const pkC = String(infoC.pubkey ?? '');
      setPubkeyC(pkC);
      res('nodeC.init+unlock', { pubkey: short(pkC, 20) });

      const addressC = await wC.getAddress();
      addLog('Funding nodeC (0.1 BTC) …');
      await sendToAddress(addressC, 0.1);
      await mine(6);
      await sleep(2000);
      await wC.syncWallet();
      await wC.createUtxos({ upTo: false, num: 5, feeRate: 7 });
      await mine(1);
      await wC.syncWallet();

      const bPeerUri = `${pkB}@127.0.0.1:${portB + 1}`;
      req('nodeC.connectPeer -> nodeB', { uri: short(bPeerUri, 30) });
      await wC.connectPeer(bPeerUri);
      await sleep(2000);
      res('nodeC.connectPeer');

      req('nodeC.openChannel (REGULAR, to nodeB)', { capacitySat: CLIENT_OPEN_CAPACITY_SAT });
      try {
        const clientOpenResp = await wC.openChannel({
          peerPubkey: bPeerUri,
          capacitySat: CLIENT_OPEN_CAPACITY_SAT,
          pushMsat: 0,
          isPublic: false,
          withAnchors: true,
        });
        const clientTmpId = String(clientOpenResp?.temporaryChannelId ?? '');
        setClientOpenChanId(clientTmpId);
        res('nodeC.openChannel', { tmpChanId: short(clientTmpId, 16) });

        addLog(`Local request accepted by nodeC's own node — waiting up to ${CLIENT_OPEN_TIMEOUT_S}s to see whether nodeB's acceptor honors it as a regular channel …`);
        const clientDeadline = Date.now() + CLIENT_OPEN_TIMEOUT_S * 1000;
        let seenOnB = false;
        while (Date.now() < clientDeadline) {
          if (abortRef.current) throw new Error('Cancelled');
          await mine(1);
          await sleep(POLL_INTERVAL_S * 1000);
          try {
            const chansB2 = (await wB.listChannels()) ?? [];
            seenOnB = (chansB2 as any[]).some(c => c.peerPubkey === pkC);
            addLog(`nodeB sees a channel from nodeC: ${seenOnB ? 'yes ✓' : 'not yet…'}`);
            if (seenOnB) break;
          } catch (e: any) {
            addLog(`listChannels (nodeB): ${e?.message ?? e}`, 'error');
          }
        }

        if (seenOnB) {
          setClientOpenOutcome('accepted');
          addLog('✓ nodeB accepted the regular open from an unlisted peer — accept-mode asymmetry does not reproduce on this build', 'success');
        } else {
          setClientOpenOutcome('timeout');
          addLog(`Never appeared on nodeB after ${CLIENT_OPEN_TIMEOUT_S}s — likely rejected on nodeB's side (check nodeB's .ldk/logs/logs.txt for "untrusted_virtual_peer"; this call only reports nodeC's local send, not nodeB's decision)`, 'error');
        }
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        setClientOpenError(msg);
        if (msg.toLowerCase().includes('untrusted_virtual_peer')) {
          setClientOpenOutcome('blocked');
          addLog(`🐛 REPRODUCED synchronously — nodeC's plain open was rejected: "${msg}" (accept-mode asymmetry, see docs/issue-virtual-channel-accept-mode.md)`, 'success');
        } else {
          setClientOpenOutcome('error');
          addLog(`nodeC.openChannel failed locally with an unexpected error (not the accept-mode signature): ${msg}`, 'error');
        }
      }

      setPhase('done');

    } catch (e: any) {
      const msg = e?.message ?? String(e);
      addLog(`Fatal: ${msg}`, 'error');
      setErrorMsg(msg);
      setPhase('error');
    }
  }, [addLog]);

  const reset = useCallback(async () => {
    abortRef.current = true;
    if (walletARef.current) { try { await walletARef.current.destroy(); } catch {} walletARef.current = null; }
    if (walletBRef.current) { try { await walletBRef.current.destroy(); } catch {} walletBRef.current = null; }
    if (walletCRef.current) { try { await walletCRef.current.destroy(); } catch {} walletCRef.current = null; }
    setPhase('idle'); setLog([]);
    setPubkeyA(''); setPubkeyB(''); setAddrA(''); setAddrB('');
    setAssetId(''); setChanA(null); setChanB(null);
    setInvoiceAB(''); setInvoiceBA(''); setStatusAB(''); setStatusBA('');
    setBalA(null); setBalB(null); setErrorMsg('');
    setCloseConfirmed(false); setReopenOutcome('pending'); setReopenErrorMsg(''); setReopenChanId('');
    setBtcChannelOutcome('pending'); setBtcChannelError(''); setBtcChannelId('');
    setPubkeyC(''); setClientOpenOutcome('pending'); setClientOpenError(''); setClientOpenChanId('');
  }, []);

  return {
    phase, log, pubkeyA, pubkeyB, addrA, addrB, assetId,
    chanA, chanB, invoiceAB, invoiceBA, statusAB, statusBA,
    balA, balB, errorMsg,
    closeConfirmed, reopenOutcome, reopenErrorMsg, reopenChanId,
    btcChannelOutcome, btcChannelError, btcChannelId,
    pubkeyC, clientOpenOutcome, clientOpenError, clientOpenChanId,
    run, reset,
  };
}
