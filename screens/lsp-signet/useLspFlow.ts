import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';
import { useCallback, useRef, useState } from 'react';

import {
  createWallet,
  PasswordRLNSigner,
  UTEXOWallet,
  type LspGetInfoResponse,
} from '@utexo/rgb-sdk-rn';

import {
  ASSET_ID, CHANNEL_TIMEOUT_MS, FAUCET_AMOUNT_SAT,
  FUND_TIMEOUT_MS, LSP_URL,
  PAYMENT_ASSET_AMOUNT, PAYMENT_MSAT, POLL_MS,
  satStr,
  SETTLE_TIMEOUT_MS,
  short, sleep,
  UNLOCK,
  type LogEntry, type Phase,
} from './config';

export function useLspFlow() {
  const [phase, setPhase]                   = useState<Phase>('idle');
  const [log,   setLog]                     = useState<LogEntry[]>([]);
  const [lspInfo,        setLspInfo]        = useState<LspGetInfoResponse | null>(null);
  const [addrA,          setAddrA]          = useState('');
  const [addrB,          setAddrB]          = useState('');
  const [balA,           setBalA]           = useState<any>(null);
  const [balB,           setBalB]           = useState<any>(null);
  const [assetInfo,      setAssetInfo]      = useState<any>(null);
  const [channelA,       setChannelA]       = useState<any>(null);
  const [channelB,       setChannelB]       = useState<any>(null);
  const [lnInvoiceA,     setLnInvoiceA]     = useState('');
  const [rgbInvoiceLsp,  setRgbInvoiceLsp]  = useState('');
  const [invoiceStatus,  setInvoiceStatus]  = useState('');
  const [lnInvoiceB,     setLnInvoiceB]     = useState('');
  const [invoiceStatusB, setInvoiceStatusB] = useState('');
  const [finalBalA,      setFinalBalA]      = useState<any>(null);
  const [finalBalB,      setFinalBalB]      = useState<any>(null);
  const [errorMsg,       setErrorMsg]       = useState('');

  const walletARef = useRef<UTEXOWallet | null>(null);
  const walletBRef = useRef<UTEXOWallet | null>(null);
  const abortRef   = useRef(false);

  const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString('en', { hour12: false });
    setLog(prev => [...prev.slice(-400), { time, msg, type }]);
    console.log(`[lsp-signet][${type}] ${msg}`);
  }, []);

  const run = useCallback(async () => {
    abortRef.current = false;
    setLog([]); setLspInfo(null);
    setAddrA(''); setAddrB(''); setBalA(null); setBalB(null);
    setAssetInfo(null); setChannelA(null); setChannelB(null);
    setLnInvoiceA(''); setRgbInvoiceLsp(''); setInvoiceStatus('');
    setLnInvoiceB(''); setInvoiceStatusB(''); setFinalBalA(null); setFinalBalB(null);
    setErrorMsg('');
    setPhase('init');

    const req = (label: string, p?: Record<string, any>) =>
      addLog(`→ ${label}${p ? '  ' + Object.entries(p).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`);
    const res = (label: string, d?: Record<string, any>) =>
      addLog(`← ${label}${d ? '  ' + Object.entries(d).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`, 'success');

    try {
      // ── Health probe ──────────────────────────────────────────────────────
      addLog(`LSP_URL = ${LSP_URL}`);
      try {
        const probe = await fetch(`${LSP_URL}/health`);
        addLog(`LSP health: ${probe.status}`, probe.ok ? 'success' : 'error');
      } catch (e: any) {
        addLog(`LSP health error: ${e?.message ?? String(e)}`, 'error');
      }

      const assetId = ASSET_ID;
      addLog(`Asset: ${short(assetId)}`, 'success');

      const ts    = Date.now();
      const portA = 33000 + Math.floor(Math.random() * 2000);
      const portB = portA + 100;
      const mkDir = async (name: string) => {
        const uri = `${documentDirectory ?? ''}lsp_sig_${name}_${ts}`;
        await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
        return uri.replace('file://', '');
      };

      // helper: poll until settled balance > 0, returns the settled amount
      const pollFunded = async (w: UTEXOWallet, label: string): Promise<number> => {
        const deadline = Date.now() + FUND_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (abortRef.current) throw new Error('Cancelled');
          await sleep(POLL_MS);
          try {
            await w.syncWallet();
            const b = await w.getBtcBalance() as any;
            const st = (b?.vanilla?.settled ?? 0) + (b?.colored?.settled ?? 0);
            addLog(`${label} settled: ${satStr(st)}`);
            if (st > 0) return st;
          } catch (e: any) { console.error(`[lsp-signet] fund poll ${label}`, e?.message ?? e); }
        }
        throw new Error(`Timed out waiting for ${label} funds`);
      };

      // helper: poll until any spendable appears (createUtxos tx confirmed)
      const pollUtxosConfirmed = async (w: UTEXOWallet, label: string): Promise<void> => {
        const deadline = Date.now() + FUND_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (abortRef.current) throw new Error('Cancelled');
          await sleep(POLL_MS);
          try {
            await w.syncWallet();
            const b = await w.getBtcBalance() as any;
            const sp = (b?.vanilla?.spendable ?? 0) + (b?.colored?.spendable ?? 0);
            addLog(`${label} spendable: ${satStr(sp)}`);
            if (sp > 0) { addLog(`${label} UTXOs confirmed ✓`, 'success'); return; }
          } catch (e: any) { console.error(`[lsp-signet] utxo poll ${label}`, e?.message ?? e); }
        }
        addLog(`${label} UTXO confirmation timeout — continuing`);
      };

      // ── Node A: init → fund → utxos → channel ────────────────────────────
      setPhase('init');

      req('createWallet nodeA');
      const keysA = await createWallet('utexo' as any);
      res('createWallet nodeA', { fingerprint: keysA.masterFingerprint });

      const wA = new UTEXOWallet(
        { storageDirPath: await mkDir('a'), daemonListeningPort: portA, ldkPeerListeningPort: portA + 1,
          network: 'utexo', lspBaseUrl: LSP_URL,
        },
        new PasswordRLNSigner('password', keysA.mnemonic),
      );
      walletARef.current = wA;

      req('nodeA.init'); await wA.init(); res('nodeA.init');
      req('nodeA.unlock'); await wA.unlock(UNLOCK); res('nodeA.unlock');

      const lspA = await wA.createLsp();
      req('lsp.getInfo');
      const info = await lspA.http.getInfo();
      setLspInfo(info);
      res('lsp.getInfo', { pubkey: short(info.pubkey), network: info.network });

      req('nodeA.getAddress');
      const adA = await wA.getAddress(); setAddrA(adA);
      res('nodeA.getAddress', { address: adA });

      setPhase('fund');
      addLog(`⚠️  Send ${FAUCET_AMOUNT_SAT} sat to nodeA on signet:`);
      addLog(`nodeA address: ${adA}`);
      await pollFunded(wA, 'nodeA');
      addLog('nodeA funded ✓', 'success');

      setPhase('utxos');
      req('nodeA.syncWallet'); await wA.syncWallet(); res('nodeA.syncWallet');
      req('nodeA.refreshWallet'); await wA.refreshWallet(); res('nodeA.refreshWallet');
      req('nodeA.createUtxos', { num: 5, feeRate: 2 });
      await wA.createUtxos({ upTo: false, num: 5, feeRate: 2 });
      res('nodeA.createUtxos');
      await pollUtxosConfirmed(wA, 'nodeA');

      setPhase('channel');
      req('lspA.connect'); await lspA.connect(); res('lspA.connect');
      addLog(`Waiting for LSP → nodeA RGB channel (asset: ${short(assetId)}) …`);
      const chanA = await lspA.waitForChannel(assetId, {
        timeoutMs:      CHANNEL_TIMEOUT_MS,
        pollIntervalMs: POLL_MS,
        onProgress:     (msg) => addLog(`nodeA ${msg}`),
      });
      setChannelA(chanA);
      addLog(`nodeA RGB channel usable ✓  cap=${chanA.capacitySat} sat`, 'success');

      // ── Node B: init → fund → utxos → channel ────────────────────────────
      setPhase('b_init');

      req('createWallet nodeB');
      const keysB = await createWallet('utexo' as any);
      res('createWallet nodeB', { fingerprint: keysB.masterFingerprint });

      const wB = new UTEXOWallet(
        { storageDirPath: await mkDir('b'), daemonListeningPort: portB, ldkPeerListeningPort: portB + 1,
          network: 'utexo', lspBaseUrl: LSP_URL,
        },
        new PasswordRLNSigner('password', keysB.mnemonic),
      );
      walletBRef.current = wB;

      req('nodeB.init'); await wB.init(); res('nodeB.init');
      req('nodeB.unlock'); await wB.unlock(UNLOCK); res('nodeB.unlock');

      const lspB = await wB.createLsp();

      req('nodeB.getAddress');
      const adB = await wB.getAddress(); setAddrB(adB);
      res('nodeB.getAddress', { address: adB });

      setPhase('b_fund');
      addLog(`⚠️  Send ${FAUCET_AMOUNT_SAT} sat to nodeB on signet:`);
      addLog(`nodeB address: ${adB}`);
      await pollFunded(wB, 'nodeB');
      addLog('nodeB funded ✓', 'success');

      setPhase('b_utxos');
      req('nodeB.syncWallet'); await wB.syncWallet(); res('nodeB.syncWallet');
      req('nodeB.refreshWallet'); await wB.refreshWallet(); res('nodeB.refreshWallet');
      req('nodeB.createUtxos', { num: 5, feeRate: 2 });
      await wB.createUtxos({ upTo: false, num: 5, feeRate: 2 });
      res('nodeB.createUtxos');
      await pollUtxosConfirmed(wB, 'nodeB');

      setPhase('b_channel');
      req('lspB.connect'); await lspB.connect(); res('lspB.connect');
      addLog('Waiting for LSP → nodeB RGB channel …');
      const chanB = await lspB.waitForChannel(assetId, {
        timeoutMs:      CHANNEL_TIMEOUT_MS,
        pollIntervalMs: POLL_MS,
        onProgress:     (msg) => addLog(`nodeB ${msg}`),
      });
      setChannelB(chanB);
      addLog('nodeB RGB channel usable ✓', 'success');

      await wA.syncWallet();
      await wB.syncWallet();

      // ── lightning_receive: Node A receives RGB over Lightning ──────────────
      setPhase('lsp_flow');

      req('lspA.receiveAsset', { assetId: short(assetId), amountSats: PAYMENT_MSAT / 1000, amountRgb: PAYMENT_ASSET_AMOUNT });
      const { lnInvoice: aInvoice, rgbInvoice } = await lspA.receiveAsset({
        assetId,
        amountSats: PAYMENT_MSAT / 1000,
        amountRgb:  PAYMENT_ASSET_AMOUNT,
      });
      setLnInvoiceA(aInvoice);
      setRgbInvoiceLsp(rgbInvoice);
      res('lspA.receiveAsset', { lnInvoice: short(aInvoice, 32), rgbInvoice: short(rgbInvoice, 32) });

      // ── Manual RGB send to LSP's RGB invoice ─────────────────────────────
      setPhase('rgb_send');

      addLog(`⚠️  MANUAL SEND REQUIRED — send ${PAYMENT_ASSET_AMOUNT} units of the asset to LSP`);
      addLog(`asset:      ${assetId}`);
      addLog(`rgb invoice: ${rgbInvoice}`);
      addLog(`amount:     ${PAYMENT_ASSET_AMOUNT}`);
      addLog('Send the asset on-chain to the RGB invoice above, then wait for settlement …');

      // onchainSend commented out — user sends manually from their own node
      // req('nodeB.onchainSend', { amount: PAYMENT_ASSET_AMOUNT, feeRate: 2 });
      // await wB.onchainSend({ invoice: rgbInvoice, amount: PAYMENT_ASSET_AMOUNT, feeRate: 2, minConfirmations: 1, skipSync: false });
      // res('nodeB.onchainSend');

      // ── Wait for LN invoice to settle (proves LSP received the RGB asset) ─
      setPhase('settle');
      addLog('Waiting for Node A LN invoice to settle (will happen once LSP receives the asset) …');
      setInvoiceStatus('Pending');
      await lspA.awaitReceiveSettlement(aInvoice, {
        timeoutMs:      SETTLE_TIMEOUT_MS,
        pollIntervalMs: POLL_MS,
        onProgress:     (s) => { setInvoiceStatus(s); addLog(`nodeA invoice: ${s}`); },
      });
      addLog('Node A LN invoice Settled ✓ — LSP paid via RGB channel!', 'success');

      try {
        await wA.syncWallet();
        const bal = await wA.getAssetBalance(assetId);
        setFinalBalA(bal);
        addLog(`nodeA asset balance: settled=${bal?.settled ?? 0} offchainInbound=${bal?.offchainInbound ?? 0}`, 'success');
      } catch {}

      // ── Part 2: Node A pays Node B ────────────────────────────────────────
      addLog('── Part 2: Node A → Node B payment ──');

      addLog('Waiting for Node A outbound RGB balance to cover payment …');
      await lspA.waitForOutboundLiquidity(PAYMENT_MSAT, {
        timeoutMs:      CHANNEL_TIMEOUT_MS,
        pollIntervalMs: POLL_MS,
        onProgress:     (msg) => addLog(msg),
      });
      addLog('Node A outbound balance ready ✓', 'success');

      await wA.syncWallet();
      await wB.syncWallet();

      setPhase('p2_pay');

      req('nodeB.createLightningInvoice', { amtMsat: PAYMENT_MSAT, assetId: short(assetId), assetAmount: PAYMENT_ASSET_AMOUNT });
      const { lnInvoice: bInvoice } = await wB.createLightningInvoice({
        amountSats:    PAYMENT_MSAT / 1000,
        expirySeconds: 3_600,
        asset: { assetId, amount: PAYMENT_ASSET_AMOUNT },
      });
      setLnInvoiceB(bInvoice);
      res('nodeB.createLightningInvoice', { invoice: short(bInvoice, 32) });

      req('nodeA.payLightningInvoice → nodeB');
      const payResult = await wA.payLightningInvoice({ lnInvoice: bInvoice });
      const payStatus = String((payResult as any)?.status ?? '').toLowerCase();
      res('nodeA.payLightningInvoice', { status: (payResult as any)?.status ?? 'sent' });
      if (payStatus === 'failed') throw new Error('nodeA.payLightningInvoice failed — check channel balance and route');

      setPhase('p2_settle');
      addLog('Waiting for Node B invoice to settle …');
      setInvoiceStatusB('Pending');
      await lspB.awaitReceiveSettlement(bInvoice, {
        timeoutMs:      SETTLE_TIMEOUT_MS,
        pollIntervalMs: POLL_MS,
        onProgress:     (s) => { setInvoiceStatusB(s); addLog(`nodeB invoice: ${s}`); },
      });
      addLog('Node B LN invoice Settled ✓ — Node A paid Node B via RGB Lightning!', 'success');

      try {
        await wB.syncWallet();
        const bal = await wB.getAssetBalance(assetId);
        setFinalBalB(bal);
        addLog(`nodeB asset balance: offchainInbound=${bal?.offchainInbound ?? 0}`, 'success');
      } catch {}

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
    setPhase('idle'); setLog([]); setLspInfo(null);
    setAddrA(''); setAddrB(''); setBalA(null); setBalB(null);
    setAssetInfo(null); setChannelA(null); setChannelB(null);
    setLnInvoiceA(''); setRgbInvoiceLsp(''); setInvoiceStatus('');
    setLnInvoiceB(''); setInvoiceStatusB(''); setFinalBalA(null); setFinalBalB(null);
    setErrorMsg('');
  }, []);

  return {
    phase, log, lspInfo,
    addrA, addrB, balA, balB,
    assetInfo, channelA, channelB,
    lnInvoiceA, rgbInvoiceLsp, invoiceStatus, finalBalA,
    lnInvoiceB, invoiceStatusB, finalBalB,
    errorMsg,
    run, reset,
  };
}
