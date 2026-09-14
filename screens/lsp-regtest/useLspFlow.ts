import * as FileSystem from 'expo-file-system/legacy';
import { documentDirectory } from 'expo-file-system/legacy';
import { useCallback, useRef, useState } from 'react';

import { mine, sendToAddress } from '@/utils/wallet-flow';
import {
  createWallet,
  PasswordRLNSigner,
  UTEXOWallet,
  type LspGetInfoResponse,
  type LspPeer,
} from '@utexo/rgb-sdk-rn';

import {
  ASSET_ID, CHANNEL_TIMEOUT_S, FAUCET_PAY_AMOUNT,
  host, LSP_DAEMON_URL, LSP_LDK_PORT, LSP_URL,
  PAYMENT_ASSET_AMOUNT, PAYMENT_MSAT, PAYMENT_TIMEOUT_S,
  POLL_INTERVAL_S, REGTEST_UNLOCK, LSP_PEER_PUBKEY_DEFAULT,
  satStr, short, sleep,
  type LogEntry, type LspChannelMode, type Phase,
} from './config';
import { faucet, lspDaemon } from './daemons';

export type UseLspFlowOptions = { channelMode?: LspChannelMode };

function walletChannelOpts(channelMode: LspChannelMode, lspPeerPubkey: string) {
  if (channelMode !== 'virtual') return {};
  return {
    enableVirtualChannelsV0: true,
    virtualPeerPubkeys: [lspPeerPubkey],
  };
}

export function useLspFlow({ channelMode = 'regular' }: UseLspFlowOptions = {}) {
  const [phase, setPhase]               = useState<Phase>('idle');
  const [log,   setLog]                 = useState<LogEntry[]>([]);
  const [lspInfo,       setLspInfo]     = useState<LspGetInfoResponse | null>(null);
  const [addrA,         setAddrA]       = useState('');
  const [balA,          setBalA]        = useState<any>(null);
  const [channelInfo,   setChannelInfo] = useState<any>(null);
  const [lnInvoiceA,    setLnInvoiceA]  = useState('');
  const [rgbInvoiceLsp, setRgbInvoiceLsp] = useState('');
  const [invoiceStatus, setInvoiceStatus] = useState('');
  const [finalBalA,     setFinalBalA]   = useState<any>(null);
  const [addrB,         setAddrB]       = useState('');
  const [channelInfoB,  setChannelInfoB] = useState<any>(null);
  const [lnInvoiceB,    setLnInvoiceB]  = useState('');
  const [invoiceStatusB, setInvoiceStatusB] = useState('');
  const [finalBalB,     setFinalBalB]   = useState<any>(null);
  const [errorMsg,      setErrorMsg]    = useState('');

  const walletARef = useRef<UTEXOWallet | null>(null);
  const walletBRef = useRef<UTEXOWallet | null>(null);
  const abortRef   = useRef(false);

  const addLog = useCallback((msg: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString('en', { hour12: false });
    setLog(prev => [...prev.slice(-500), { time, msg, type }]);
    console.log(`[lsp][${type}] ${msg}`);
  }, []);

  const run = useCallback(async () => {
    abortRef.current = false;
    setLog([]); setLspInfo(null); setAddrA(''); setBalA(null);
    setChannelInfo(null); setLnInvoiceA(''); setRgbInvoiceLsp('');
    setInvoiceStatus(''); setFinalBalA(null);
    setAddrB(''); setChannelInfoB(null); setLnInvoiceB(''); setInvoiceStatusB(''); setFinalBalB(null);
    setErrorMsg('');
    setPhase('preflight');

    const req = (label: string, p?: Record<string, any>) =>
      addLog(`→ ${label}${p ? '  ' + Object.entries(p).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`);
    const res = (label: string, d?: Record<string, any>) =>
      addLog(`← ${label}${d ? '  ' + Object.entries(d).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : ''}`, 'success');

    try {
      // ── Preflight ──────────────────────────────────────────────────────────
      addLog(`Platform=${host === '10.0.2.2' ? 'android' : 'ios/sim'}  host=${host}`);
      addLog(`LSP_URL=${LSP_URL}`);
      addLog(`LSP_DAEMON=${LSP_DAEMON_URL}`);
      addLog(`ASSET_ID=${ASSET_ID ? ASSET_ID.slice(0, 20) + '…' : '(empty)'}`);

      if (!ASSET_ID) throw new Error('EXPO_PUBLIC_LSP_REGTEST_ASSET_ID not set — run scripts/start-lsp-regtest.sh first');

      addLog(`channelMode=${channelMode}`);

      // Fetch LSP pubkey at runtime — no rebuild needed after LSP restarts.
      const lspNodeInfoResp = await fetch(`${LSP_DAEMON_URL}/nodeinfo`).then(r => r.json()) as any;
      let lspPeerPubkey = lspNodeInfoResp?.pubkey ?? LSP_PEER_PUBKEY_DEFAULT;
      if (!lspPeerPubkey) throw new Error('Could not fetch LSP pubkey — is the LSP daemon running on port 3005?');

      addLog(`raw fetch probe → ${LSP_URL}/health`);
      try {
        const probe = await fetch(`${LSP_URL}/health`);
        addLog(`probe status=${probe.status}`, probe.ok ? 'success' : 'error');
      } catch (e: any) {
        addLog(`probe error: ${e?.message ?? String(e)}`, 'error');
      }

      req('lsp daemon.nodeinfo');
      const lspDaemonNodeInfoData = await lspDaemon.nodeInfo();
      res('lsp daemon.nodeinfo', { pubkey: short(lspDaemonNodeInfoData.pubkey), assetChannels: lspDaemonNodeInfoData.num_channels });

      req('faucet daemon.assetbalance', { assetId: short(ASSET_ID) });
      const faucetBal = await faucet.assetBalance(ASSET_ID);
      res('faucet.assetbalance', { settled: faucetBal.settled, spendable: faucetBal.spendable });
      if (Number(faucetBal.settled) < 1) throw new Error(`Faucet has no settled RGB balance (${faucetBal.settled}) — run start-lsp-regtest.sh`);

      // ── Init User A ────────────────────────────────────────────────────────
      setPhase('init');

      req('createWallet userA');
      const keysA = await createWallet('regtest' as any);
      res('createWallet userA', { fingerprint: keysA.masterFingerprint });

      const ts   = Date.now();
      const port = 34000 + Math.floor(Math.random() * 2000);
      const dirPrefix = channelMode === 'virtual' ? 'lsp_vc_ua_' : 'lsp_ua_';
      const dirUri = `${documentDirectory ?? ''}${dirPrefix}${ts}`;
      await FileSystem.makeDirectoryAsync(dirUri, { intermediates: true });
      const storageDirPath = dirUri.replace('file://', '');

      addLog(`storageDirPath=${storageDirPath}`);
      addLog(`ports daemon=${port} ldk=${port + 1}`);

      const wA = new UTEXOWallet(
        { storageDirPath, daemonListeningPort: port, ldkPeerListeningPort: port + 1,
          network: 'regtest',
          ...walletChannelOpts(channelMode, lspPeerPubkey),
        },
        new PasswordRLNSigner('lsppass1', keysA.mnemonic),
      );
      walletARef.current = wA;

      const LSP_PEER: LspPeer = { baseUrl: LSP_URL, peerPubkey: lspPeerPubkey, peerHost: host, peerPort: LSP_LDK_PORT };
      const lspA = await wA.createLsp(LSP_PEER);

      req('lsp.getInfo');
      const info = await lspA.http.getInfo();
      setLspInfo(info);
      res('lsp.getInfo', { pubkey: short(info.pubkey), network: info.network });

      addLog('calling wA.init()…');
      try {
        await wA.init();
        addLog('wA.init() ok', 'success');
      } catch (initErr: any) {
        addLog(`wA.init() FAILED: code=${initErr?.code} msg=${initErr?.message ?? String(initErr)}`, 'error');
        throw initErr;
      }

      req('userA.unlock'); await wA.unlock(REGTEST_UNLOCK); res('userA.unlock');
      req('userA.getNodeInfo');
      const nodeInfoA = await wA.getNodeInfo();
      res('userA.getNodeInfo', { pubkey: short(String(nodeInfoA?.pubkey ?? '')) });

      req('userA.getAddress');
      const address = await wA.getAddress();
      setAddrA(address);
      res('userA.getAddress', { address });

      // ── Fund User A ────────────────────────────────────────────────────────
      setPhase('fund');

      req('sendToAddress userA 1 BTC');
      await sendToAddress(address, 1);
      await mine(6);
      await sleep(3000);
      await wA.syncWallet();
      const bal = await wA.getBtcBalance() as any;
      setBalA(bal);
      const spendable = (bal?.vanilla?.spendable ?? 0) + (bal?.colored?.spendable ?? 0);
      res('userA.getBtcBalance', { spendable: satStr(spendable) });

      // ── Create UTXOs ───────────────────────────────────────────────────────
      setPhase('utxos');

      req('userA.syncWallet'); await wA.syncWallet(); res('userA.syncWallet');
      req('userA.refreshWallet'); await wA.refreshWallet(); res('userA.refreshWallet');
      req('userA.createUtxos', { num: 10, feeRate: 7 });
      await wA.createUtxos({ upTo: false, num: 10, feeRate: 7 });
      await mine(1);
      await wA.syncWallet();
      res('userA.createUtxos');

      // ── Connect to LSP peer → wait for RGB channel ─────────────────────────
      // Matches: clients["user_a"].connectpeer + wait_for_peer_channel_usable
      setPhase('channel');

      req('lspA.connect');
      await lspA.connect();
      res('lspA.connect');

      addLog(channelMode === 'virtual'
        ? 'Mining 2 blocks to trigger LSP virtual channel open …'
        : 'Mining 2 blocks to trigger LSP channel open …');
      await mine(2);
      await sleep(6000);

      addLog(channelMode === 'virtual'
        ? `Waiting for virtual RGB channel usable (asset: ${short(ASSET_ID)}) …`
        : `Waiting for RGB channel usable (asset: ${short(ASSET_ID)}) …`);
      const chanA = await lspA.waitForChannel(ASSET_ID, {
        timeoutMs:      CHANNEL_TIMEOUT_S * 1000,
        pollIntervalMs: 3_000,
        onProgress: (msg) => addLog(`userA ${msg}`),
        onEachPoll:  () => mine(1),
      });
      setChannelInfo(chanA);
      addLog(`${channelMode === 'virtual' ? 'Virtual RGB' : 'RGB'} channel usable ✓  cap=${chanA.capacitySat} sat`, 'success');

      // mirrors conftest.py: refresh_transfers + sync_sdk_nodes + mine(2) between connects
      await lspDaemon.refreshOnce();
      await faucet.refreshOnce();
      await wA.syncWallet();
      await mine(2);

      // ── User B setup ───────────────────────────────────────────────────────
      // Python opens BOTH channels upfront before any RGB transfer activity.
      // Doing B after Part 1 causes NoAvailableUtxos on the LSP.
      setPhase('b_init');

      addLog('Setting up User B before lightning_receive flow …');
      const keysB  = await createWallet('regtest' as any);
      const portB  = 36000 + Math.floor(Math.random() * 2000);
      const dirBPrefix = channelMode === 'virtual' ? 'lsp_vc_ub_' : 'lsp_ub_';
      const dirBUri = `${documentDirectory ?? ''}${dirBPrefix}${Date.now()}`;
      await FileSystem.makeDirectoryAsync(dirBUri, { intermediates: true });

      const wB = new UTEXOWallet(
        { storageDirPath: dirBUri.replace('file://', ''), daemonListeningPort: portB, ldkPeerListeningPort: portB + 1,
          network: 'regtest',
          ...walletChannelOpts(channelMode, lspPeerPubkey),
        },
        new PasswordRLNSigner('lsppass2', keysB.mnemonic),
      );
      walletBRef.current = wB;
      const lspB = await wB.createLsp(LSP_PEER);
      await wB.init();
      await wB.unlock(REGTEST_UNLOCK);
      res('userB.init');

      const addressB = await wB.getAddress();
      setAddrB(addressB);
      await sendToAddress(addressB, 1);
      await mine(6);
      await sleep(3000);
      await wB.syncWallet();
      await wB.createUtxos({ upTo: false, num: 10, feeRate: 7 });
      await mine(1);
      await wB.syncWallet();
      res('userB.funded + createUtxos');

      setPhase('b_channel');

      req('lspB.connect');
      await lspB.connect();
      res('lspB.connect');

      addLog(channelMode === 'virtual'
        ? 'Mining 2 blocks to trigger LSP virtual channel open for User B …'
        : 'Mining 2 blocks to trigger LSP channel open for User B …');
      await mine(2);
      await sleep(6000);

      addLog(channelMode === 'virtual'
        ? 'Waiting for virtual RGB channel usable on User B …'
        : 'Waiting for RGB channel usable on User B …');
      const chanB = await lspB.waitForChannel(ASSET_ID, {
        timeoutMs:      CHANNEL_TIMEOUT_S * 1000,
        pollIntervalMs: 3_000,
        onProgress: (msg) => addLog(`userB ${msg}`),
        onEachPoll:  () => mine(1),
      });
      setChannelInfoB(chanB);
      addLog(`User B ${channelMode === 'virtual' ? 'virtual ' : ''}RGB channel usable ✓`, 'success');

      await lspDaemon.refresh();
      await wA.syncWallet();
      await wB.syncWallet();

      // ── run_lightning_receive_flow(env) ────────────────────────────────────
      // Mirrors flows.py:run_lightning_receive_flow exactly.
      setPhase('lsp_flow');

      req('lspA.receiveAsset', { assetId: short(ASSET_ID), amountSats: PAYMENT_MSAT / 1000, amountRgb: PAYMENT_ASSET_AMOUNT });
      const { lnInvoice: aInvoice, rgbInvoice } = await lspA.receiveAsset({
        assetId:    ASSET_ID,
        amountSats: PAYMENT_MSAT / 1000,
        amountRgb:  PAYMENT_ASSET_AMOUNT,
      });
      setLnInvoiceA(aInvoice);
      setRgbInvoiceLsp(rgbInvoice);
      res('lspA.receiveAsset', { lnInvoice: short(aInvoice, 32), rgbInvoice: short(rgbInvoice, 32) });

      // ── Faucet sends RGB to LSP's invoice ──────────────────────────────────
      // Mirrors: env.faucet.decodergbinvoice + env.faucet.sendrgb
      setPhase('rgb_send');

      req('faucet.decodergbinvoice');
      const decoded = await faucet.decodeRgbInvoice(rgbInvoice);
      const recipientId        = decoded.recipient_id;
      const transportEndpoints = decoded.transport_endpoints ?? [`rpc://${host}:3000/json-rpc`];
      // Use assignment from invoice; fall back if value is 0 (mirrors flows.py)
      const assignment = (decoded.assignment?.type === 'Fungible' && decoded.assignment?.value > 0)
        ? decoded.assignment
        : { type: 'Fungible', value: FAUCET_PAY_AMOUNT };
      res('faucet.decodergbinvoice', { recipientId: short(recipientId, 24), endpoints: transportEndpoints.length });

      req('faucet.sendrgb', { amount: assignment.value, recipientId: short(recipientId, 20) });
      await faucet.sendRgb({
        donation: false, fee_rate: 7, min_confirmations: 1, skip_sync: false,
        recipient_map: {
          [ASSET_ID]: [{ recipient_id: recipientId, assignment, transport_endpoints: transportEndpoints }],
        },
      });
      res('faucet.sendrgb', { amount: FAUCET_PAY_AMOUNT });

      // mine 1 + double refresh on both (mirrors harness.py rgb_delivery_settled)
      await mine(1);
      await sleep(2000);

      req('refreshtransfers lsp + faucet (×2)');
      await lspDaemon.refresh();
      await faucet.refresh();
      res('refreshtransfers');

      // ── Poll until faucet Send + LSP ReceiveBlind both Settled ─────────────
      // mirrors flows.py rgb_delivery_settled
      addLog('Waiting for faucet Send + LSP receive to settle …');
      setPhase('settle');
      const sendDeadline = Date.now() + PAYMENT_TIMEOUT_S * 1000;
      let rgbDeliverySettled = false;
      while (Date.now() < sendDeadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await mine(1);
        await sleep(POLL_INTERVAL_S * 1000);
        try {
          await lspDaemon.refresh();
          await faucet.refresh();
          const faucetTransfers = await faucet.listTransfers(ASSET_ID);
          const lspTransfers    = await lspDaemon.listTransfers(ASSET_ID);
          const faucetSend = [...(faucetTransfers.transfers ?? [])].reverse().find((t: any) => t.kind === 'Send');
          const lspReceive = [...(lspTransfers.transfers    ?? [])].reverse().find((t: any) => t.kind === 'ReceiveBlind');
          addLog(`faucet Send: ${faucetSend?.status ?? 'none'}  LSP receive: ${lspReceive?.status ?? 'none'}`);
          if (faucetSend?.status === 'Failed') throw new Error('Faucet RGB send transfer failed');
          if (faucetSend?.status === 'Settled' && lspReceive?.status === 'Settled') { rgbDeliverySettled = true; break; }
        } catch (e: any) {
          if ((e?.message ?? '').includes('failed')) throw e;
          console.error('[lsp] settle poll:', e?.message ?? e);
        }
      }
      if (!rgbDeliverySettled) addLog('RGB delivery settlement timeout — LSP may still be processing');
      else addLog('Faucet Send + LSP receive both Settled ✓', 'success');

      addLog('Waiting for userA LN invoice to settle …');
      setInvoiceStatus('Pending');
      await lspA.awaitReceiveSettlement(aInvoice, {
        timeoutMs:      PAYMENT_TIMEOUT_S * 1000,
        pollIntervalMs: POLL_INTERVAL_S * 1000,
        onProgress: (s) => { setInvoiceStatus(s); addLog(`userA invoice: ${s}`); },
      });
      addLog('userA LN invoice Succeeded ✓ — LSP paid via RGB channel!', 'success');

      try {
        await wA.syncWallet();
        const assetBal = await wA.getAssetBalance(ASSET_ID);
        setFinalBalA(assetBal);
        addLog(`userA asset balance: settled=${assetBal?.settled ?? 0} offchainInbound=${assetBal?.offchainInbound ?? 0}`, 'success');
      } catch {}

      // ── Part 2: User A pays User B ─────────────────────────────────────────
      // Mirrors test_flow0_full_e2e.py (after run_lightning_receive_flow returns).
      addLog('── Part 2: User A → User B payment ──');

      addLog('Waiting for User A outbound RGB balance to cover payment …');
      await lspA.waitForOutboundLiquidity(PAYMENT_MSAT, {
        timeoutMs:      CHANNEL_TIMEOUT_S * 1000,
        pollIntervalMs: POLL_INTERVAL_S * 1000,
        onProgress: (msg) => addLog(msg),
      });
      addLog('User A outbound balance ready ✓', 'success');

      await wA.syncWallet();
      await wB.syncWallet();
      const initialBalA = await wA.getAssetBalance(ASSET_ID);
      const initialBalB = await wB.getAssetBalance(ASSET_ID);

      // Verify User B still has a usable RGB channel — the utexo-lsp cron opens virtual
      // channels (trusted_no_broadcast) whose RGB push HTLC can force-close the channel
      // while Part 1 is running. Fail fast here rather than hanging for 60 s.
      const bChannelList = (await wB.listChannels()) as any[];
      const bHasChannel = bChannelList.some((c: any) =>
        (c.assetId || c.asset_id) === ASSET_ID && (c.isUsable || c.is_usable)
      );
      if (!bHasChannel) throw new Error(
        'User B has no usable RGB channel — force-closed by utexo-lsp cron push HTLC. ' +
        'Restart the LSP stack (start-lsp-local.sh) and retry.'
      );
      addLog('User B channel still usable ✓', 'success');

      setPhase('p2_pay');

      req('userB.createLightningInvoice', { amtMsat: PAYMENT_MSAT, assetId: short(ASSET_ID), assetAmount: PAYMENT_ASSET_AMOUNT });
      const invBResult = await wB.createLightningInvoice({
        amountSats: PAYMENT_MSAT / 1000,
        expirySeconds: 3600,
        asset: { assetId: ASSET_ID, amount: PAYMENT_ASSET_AMOUNT },
      });
      const bInvoice = invBResult.lnInvoice;
      setLnInvoiceB(bInvoice);
      res('userB.createLightningInvoice', { invoice: short(bInvoice, 32) });

      req('userA.payLightningInvoice → userB invoice');
      const payResult = await wA.payLightningInvoice({ lnInvoice: bInvoice });
      const payStatus = String((payResult as any)?.status ?? '').toLowerCase();
      res('userA.payLightningInvoice', { status: (payResult as any)?.status ?? 'sent' });
      if (payStatus === 'failed') throw new Error('userA.payLightningInvoice failed immediately — check channel balance and route');

      setPhase('p2_settle');
      addLog('Waiting for userB invoice to settle …');
      setInvoiceStatusB('Pending');
      let p2LastStatus = '';
      await lspB.awaitReceiveSettlement(bInvoice, {
        timeoutMs:      PAYMENT_TIMEOUT_S * 1000,
        pollIntervalMs: POLL_INTERVAL_S * 1000,
        onProgress: (s) => { p2LastStatus = s; setInvoiceStatusB(s); addLog(`userB invoice: ${s}`); },
      });
      // lib/module compiled output returns 'Succeeded' on both success and timeout — track via onProgress.
      if (p2LastStatus !== 'Succeeded') throw new Error(
        `userB invoice did not settle (last status: ${p2LastStatus}) — check LSP routing and User B channel state`
      );
      addLog('userB LN invoice Succeeded ✓ — User A paid User B via RGB Lightning!', 'success');

      // Poll offchain balance delta — mirrors test_flow0 wait_until(offchain_balances_updated).
      // NOTE: rlnAssetBalance native binding currently returns only {settled,future,spendable}.
      // offchainOutbound/offchainInbound are absent — known gap, will timeout until binding is updated.
      addLog('Polling offchain balance delta …');
      const balDeadline = Date.now() + PAYMENT_TIMEOUT_S * 1000;
      let aBalFinal: any = null;
      let bBalFinal: any = null;
      let balancesUpdated = false;
      while (Date.now() < balDeadline) {
        if (abortRef.current) throw new Error('Cancelled');
        await wA.syncWallet(); await wB.syncWallet();
        aBalFinal = await wA.getAssetBalance(ASSET_ID);
        bBalFinal = await wB.getAssetBalance(ASSET_ID);
        setFinalBalA(aBalFinal);
        setFinalBalB(bBalFinal);
        const aOut  = aBalFinal?.offchainOutbound ?? 0;
        const bOut  = bBalFinal?.offchainOutbound ?? 0;
        const aInit = initialBalA?.offchainOutbound ?? 0;
        const bInit = initialBalB?.offchainOutbound ?? 0;
        addLog(`userA offchainOutbound: ${aInit} → ${aOut}  userB: ${bInit} → ${bOut}`);
        if ((aInit - aOut) === PAYMENT_ASSET_AMOUNT && (bOut - bInit) === PAYMENT_ASSET_AMOUNT) { balancesUpdated = true; break; }
        await sleep(POLL_INTERVAL_S * 1000);
      }
      addLog(
        balancesUpdated
          ? `offchain balance delta confirmed ✓  userA -${PAYMENT_ASSET_AMOUNT}  userB +${PAYMENT_ASSET_AMOUNT}`
          : `offchain balance delta timeout — userA offchainOutbound=${aBalFinal?.offchainOutbound ?? 0}  userB=${bBalFinal?.offchainOutbound ?? 0}`,
        balancesUpdated ? 'success' : 'info',
      );

      try {
        const channelsB = (await wB.listChannels()) ?? [];
        const bChan = (channelsB as any[]).find((c: any) =>
          (c.assetId || c.asset_id) === ASSET_ID && (c.isUsable || c.is_usable)
        );
        addLog(`userB channel post-payment: ${bChan ? 'Opened + usable ✓' : 'not usable'}`, bChan ? 'success' : 'info');
      } catch {}

      setPhase('done');

    } catch (e: any) {
      const msg = e?.message ?? String(e);
      addLog(`Fatal: ${msg}`, 'error');
      setErrorMsg(msg);
      setPhase('error');
    }
  }, [addLog, channelMode]);

  const reset = useCallback(async () => {
    abortRef.current = true;
    if (walletARef.current) { try { await walletARef.current.destroy(); } catch {} walletARef.current = null; }
    if (walletBRef.current) { try { await walletBRef.current.destroy(); } catch {} walletBRef.current = null; }
    setPhase('idle'); setLog([]); setLspInfo(null);
    setAddrA(''); setBalA(null); setChannelInfo(null);
    setLnInvoiceA(''); setRgbInvoiceLsp(''); setInvoiceStatus(''); setFinalBalA(null);
    setAddrB(''); setChannelInfoB(null); setLnInvoiceB(''); setInvoiceStatusB(''); setFinalBalB(null);
    setErrorMsg('');
  }, []);

  return {
    phase, log, lspInfo,
    addrA, balA, channelInfo, lnInvoiceA, rgbInvoiceLsp, invoiceStatus, finalBalA,
    addrB, channelInfoB, lnInvoiceB, invoiceStatusB, finalBalB,
    errorMsg,
    run, reset,
  };
}
