import { useRef, useState } from 'react';
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
import VirtualChannelScreen from '@/screens/virtual-channel/index';
import VirtualChannelBtcScreen from '@/screens/virtual-channel-btc/index';
import VirtualChannelSignetScreen from '@/screens/virtual-channel-signet/index';
import {
  buildMainnetConfig,
  buildRegtestConfig,
  buildUtexoConfig,
  runExtSignerOnchainSendFlow,
  runMainnetInitFlow,
  runRLNUtexoExternalPaymentFlow,
  runRLNUtexoPaymentFlow,
  runRlnUtexoVssFlow,
  runRlnUtexoWalletAssetChannelExtSignerFlow,
  runRlnUtexoWalletChannelPaymentFlow,
  runRlnVssFlow,
} from '@/utils/wallet-flow';


// ─── Types ────────────────────────────────────────────────────────────────────

type FlowResults = Record<string, any> | null;

// ─── Step card component ──────────────────────────────────────────────────────

function formatDetail(data: any): string {
  if (data === null || data === undefined) return '';
  if (typeof data === 'string') return data;
  if (typeof data === 'number' || typeof data === 'boolean') return String(data);
  if (typeof data === 'object') {
    return Object.entries(data)
      .map(([k, v]) => {
        const val = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
        return `${k}  ${val}`;
      })
      .join('\n');
  }
  return JSON.stringify(data);
}

function StepCard({
  idx,
  step,
  label,
  desc,
  accentColor,
  isLast,
  deferErrorDisplay = false,
}: {
  idx: number;
  step: { status: string; data?: any; error?: string; result?: any };
  label: string;
  desc: string;
  accentColor: string;
  isLast: boolean;
  deferErrorDisplay?: boolean;
}) {
  const isSuccess = step.status === 'success';
  const isRunning = step.status === 'running';
  const isError = step.status === 'error';
  const showErrorState = isError && !deferErrorDisplay;

  const detail = step.data ?? step.result;

  const circleColor = isSuccess
    ? AppColors.success
    : isRunning
    ? accentColor
    : showErrorState
    ? AppColors.error
    : AppColors.textTertiary;

  const circleBg = isSuccess
    ? AppColors.successBg
    : isRunning
    ? accentColor + '18'
    : showErrorState
    ? AppColors.errorBg
    : AppColors.bgCardElevated;

  return (
    <View style={sStyles.row}>
      {/* Timeline column */}
      <View style={sStyles.timelineCol}>
        <View style={[sStyles.circle, { borderColor: circleColor, backgroundColor: circleBg }]}>
          {isRunning ? (
            <ActivityIndicator size={12} color={accentColor} />
          ) : isSuccess ? (
            <Text style={[sStyles.circleText, { color: AppColors.success }]}>✓</Text>
          ) : showErrorState ? (
            <Text style={[sStyles.circleText, { color: AppColors.error }]}>✗</Text>
          ) : (
            <Text style={[sStyles.circleText, { color: AppColors.textTertiary }]}>{idx + 1}</Text>
          )}
        </View>
        {!isLast && (
          <View style={[sStyles.line, { backgroundColor: isSuccess ? AppColors.success + '50' : AppColors.border }]} />
        )}
      </View>

      {/* Content column */}
      <View style={[sStyles.stepContent, !isLast && sStyles.stepContentSpaced]}>
        <View style={sStyles.stepTitleRow}>
          <Text style={[
            sStyles.stepLabel,
            isSuccess && { color: AppColors.textPrimary },
            showErrorState && { color: AppColors.error },
            isRunning && { color: accentColor },
          ]}>
            {label}
          </Text>
          {isRunning && (
            <View style={[sStyles.statusTag, { backgroundColor: accentColor + '18', borderColor: accentColor + '40' }]}>
              <Text style={[sStyles.statusTagText, { color: accentColor }]}>running</Text>
            </View>
          )}
          {showErrorState && (
            <View style={[sStyles.statusTag, { backgroundColor: AppColors.errorBg, borderColor: AppColors.errorBorder }]}>
              <Text style={[sStyles.statusTagText, { color: AppColors.error }]}>failed</Text>
            </View>
          )}
        </View>
        <Text style={sStyles.stepDesc}>{desc}</Text>
        {(detail || step.error) && (
          <View style={[sStyles.codeBox, showErrorState && { borderColor: AppColors.errorBorder, backgroundColor: AppColors.errorBg }]}>
            <Text style={[sStyles.codeText, showErrorState && { color: '#FCA5A5' }]}>
              {detail ? formatDetail(detail) : step.error}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

// ─── Flow card component ──────────────────────────────────────────────────────

function FlowCard({
  title,
  funcName,
  tags,
  description,
  accentColor,
  totalSteps,
  results,
  running,
  onRun,
  children,
  extra,
}: {
  title: string;
  funcName: string;
  tags?: string[];
  description: string;
  accentColor: string;
  totalSteps?: number;
  results: FlowResults;
  running: boolean;
  onRun: () => void;
  children?: React.ReactNode;
  extra?: React.ReactNode;
}) {
  const hasResults = results !== null;
  const success = results?.success;
  const steps = results?.steps ?? [];
  const effectiveRunning = running || results?.running === true;
  const doneCount = steps.filter((s: any) => s.status === 'success').length;
  const total = totalSteps ?? steps.length;
  const borderColor = !hasResults
    ? AppColors.border
    : effectiveRunning
    ? AppColors.border
    : success
    ? AppColors.successBorder
    : AppColors.errorBorder;

  return (
    <View style={[fStyles.card, { borderColor }]}>
      {/* Card header */}
      <View style={[fStyles.cardHeader, { borderBottomColor: AppColors.border }]}>
        <View style={[fStyles.cardAccentBar, { backgroundColor: accentColor }]} />
        <View style={fStyles.cardTitleArea}>
          <View style={fStyles.cardTitleRow}>
            <Text style={fStyles.cardTitle}>{title}</Text>
            {effectiveRunning && <ActivityIndicator size="small" color={accentColor} style={{ marginLeft: 6 }} />}
            {hasResults && !effectiveRunning && (
              <View style={[fStyles.statusPill, { backgroundColor: success ? AppColors.successBg : AppColors.errorBg, borderColor: success ? AppColors.successBorder : AppColors.errorBorder }]}>
                <Text style={[fStyles.statusText, { color: success ? AppColors.success : AppColors.error }]}>
                  {success ? 'Passed' : 'Failed'}
                </Text>
              </View>
            )}
          </View>
          <Text style={fStyles.funcName}>{funcName}()</Text>
          {tags && tags.length > 0 && (
            <View style={fStyles.tagRow}>
              {tags.map(tag => (
                <View key={tag} style={[fStyles.tag, tag === 'RGB Sends' && fStyles.tagRgb]}>
                  <Text style={[fStyles.tagText, tag === 'RGB Sends' && fStyles.tagTextRgb]}>{tag}</Text>
                </View>
              ))}
            </View>
          )}
          <Text style={fStyles.cardDesc}>{description}</Text>
        </View>
      </View>

      {/* Flow-level error summary */}
      {hasResults && !effectiveRunning && success === false && results?.error && (
        <View style={fStyles.flowErrorBox}>
          <Text style={fStyles.flowErrorTitle}>Failure reason</Text>
          <Text style={fStyles.flowErrorText}>{formatDetail(results.error)}</Text>
        </View>
      )}

      {/* Progress dots */}
      {steps.length > 0 && total > 0 && (
        <View style={fStyles.progressRow}>
          {Array.from({ length: total }).map((_, i) => {
            const s = steps[i];
            const dotColor = !s
              ? AppColors.border
              : s.status === 'success'
              ? AppColors.success
              : s.status === 'running'
              ? accentColor
              : s.status === 'error'
              ? effectiveRunning
                ? AppColors.border
                : AppColors.error
              : AppColors.border;
            return (
              <View key={i} style={[fStyles.dot, { backgroundColor: dotColor }]}>
                {s?.status === 'running' && <ActivityIndicator size={8} color="#fff" />}
              </View>
            );
          })}
          {typeof totalSteps === 'number' && totalSteps > 0 ? (
            <Text style={fStyles.progressLabel}>{doneCount}/{total}</Text>
          ) : null}
        </View>
      )}

      {/* Idle state */}
      {!hasResults && !effectiveRunning && (
        <View style={fStyles.idleBody}>
          <TouchableOpacity
            style={[fStyles.runBtn, { backgroundColor: accentColor }]}
            onPress={onRun}
            activeOpacity={0.8}>
            <Text style={fStyles.runBtnText}>▶  Run</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Step list */}
      {children && (
        <View style={fStyles.stepsWrapper}>
          {children}
        </View>
      )}

      {/* Extra content (e.g. store ID) */}
      {extra}

      {/* Re-run button */}
      {hasResults && !effectiveRunning && (
        <TouchableOpacity
          style={[fStyles.rerunBtn, { borderColor: accentColor }]}
          onPress={onRun}
          activeOpacity={0.8}>
          <Text style={[fStyles.rerunBtnText, { color: accentColor }]}>↺  Re-run</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}


const RLN_DEMO_STEP_META: Record<string, { label: string; desc: string }> = {
  rlnCreateNode: { label: 'Create Node', desc: 'Create RLN node with local storage and ports' },
  rlnInitNode: { label: 'Init Node', desc: 'Initialize node with wallet mnemonic' },
  rlnUnlockNode: { label: 'Unlock Node', desc: 'Unlock node with bitcoind/indexer/proxy settings' },
  rlnNodeInfo: { label: 'Node Info', desc: 'Read node summary and balances' },
  rlnNetworkInfo: { label: 'Network Info', desc: 'Read chain network and height' },
  rlnListPeers: { label: 'List Peers', desc: 'Fetch currently known peers' },
  rlnConnectPeer: { label: 'Connect Peer', desc: 'Connect to test peer endpoint' },
  rlnDisconnectPeer: { label: 'Disconnect Peer', desc: 'Disconnect selected peer pubkey' },
  rlnListChannels: { label: 'List Channels', desc: 'Fetch currently known channels' },
  rlnOpenChannel: { label: 'Open Channel', desc: 'Try opening a test channel' },
  rlnCloseChannel: { label: 'Close Channel', desc: 'Close opened channel when available' },
  rlnListPayments: { label: 'List Payments', desc: 'Fetch payments history from RLN node' },
  rlnAddress: { label: 'Address', desc: 'Request onchain receive address' },
  fundAddress: { label: 'Fund Address', desc: 'Send BTC to node address and mine confirmation blocks' },
  rlnBtcBalance: { label: 'BTC Balance', desc: 'Read BTC balances from RLN node' },
  rlnAssetBalance: { label: 'Asset Balance', desc: 'Read RGB asset balance for provided assetId' },
  rlnCheckIndexerUrl: { label: 'Check Indexer URL', desc: 'Validate indexer endpoint reachability' },
  rlnCheckProxyEndpoint: { label: 'Check Proxy Endpoint', desc: 'Validate proxy endpoint reachability' },
  rlnEstimateFee: { label: 'Estimate Fee', desc: 'Estimate fee rates for target blocks' },
  rlnCreateUtxos: { label: 'Create UTXOs', desc: 'Request UTXO creation on RLN node wallet' },
  rlnDecodeLnInvoice: { label: 'Decode LN Invoice', desc: 'Decode BOLT11 lightning invoice string' },
  rlnDecodeRgbInvoice: { label: 'Decode RGB Invoice', desc: 'Decode RGB invoice string' },
  rlnFailTransfers: { label: 'Fail Transfers', desc: 'Mark pending transfers as failed' },
  rlnGetChannelId: { label: 'Get Channel ID', desc: 'Resolve channel id from temporary id' },
  rlnGetPayment: { label: 'Get Payment', desc: 'Lookup payment by payment hash' },
  rlnInvoiceStatus: { label: 'Invoice Status', desc: 'Read status for LN invoice' },
  rlnKeysend: { label: 'Keysend', desc: 'Send keysend payment attempt' },
  rlnListAssets: { label: 'List Assets', desc: 'List RGB assets tracked by RLN wallet' },
  rlnListTransactions: { label: 'List Transactions', desc: 'List onchain transactions' },
  rlnListTransfers: { label: 'List Transfers', desc: 'List RGB transfers for assetId' },
  rlnListUnspents: { label: 'List Unspents', desc: 'List spendable unspent outputs' },
  rlnLnInvoice: { label: 'Create LN Invoice', desc: 'Create lightning invoice request' },
  rlnRefreshTransfers: { label: 'Refresh Transfers', desc: 'Refresh transfer statuses from network' },
  rlnRgbInvoice: { label: 'Create RGB Invoice', desc: 'Create RGB receive invoice request' },
  rlnSendBtc: { label: 'Send BTC', desc: 'Send onchain BTC transaction attempt' },
  rlnSendPayment: { label: 'Send Payment', desc: 'Pay lightning invoice attempt' },
  rlnSendRgb: { label: 'Send RGB', desc: 'Send RGB transfer attempt' },
  rlnBackup: { label: 'Backup', desc: 'Trigger RLN wallet backup request' },
  rlnSync: { label: 'Sync', desc: 'Sync RLN node wallet state' },
  rlnLock: { label: 'Lock', desc: 'Not supported in current RLN bindings' },
  rlnRestore: { label: 'Restore', desc: 'Wallet-level restore, not RLN node method' },
  rlnShutdown: { label: 'Shutdown', desc: 'Shutdown RLN node process' },
  rlnDestroyNode: { label: 'Destroy Node', desc: 'Destroy node handle and cleanup resources' },
  rlnCreateNativeExternalSigner: { label: 'Create External Signer', desc: 'Create native external signer from BIP39 seed' },
  rlnInitNodeWithNativeExternalSigner: { label: 'Init With External Signer', desc: 'Initialize node using native external signer instead of password' },
  rlnUnlockNodeWithNativeExternalSigner: { label: 'Unlock With External Signer', desc: 'Unlock node using native external signer with bitcoind/indexer settings' },
  rlnDestroyNativeExternalSigner: { label: 'Destroy External Signer', desc: 'Destroy native external signer handle' },
  rlnSyncBeforeRestart: { label: 'Sync Before Restart', desc: 'Sync node before restart sequence' },
  rlnShutdownForRestart: { label: 'Shutdown For Restart', desc: 'Shutdown node to validate restart lifecycle' },
  rlnUnlockAfterRestart: { label: 'Unlock After Restart', desc: 'Unlock node again after shutdown' },
  rlnNodeInfoAfterRestart: { label: 'Node Info After Restart', desc: 'Validate node information after restart' },
  rlnOpenCloseCycle1: { label: 'Open/Close Cycle 1', desc: 'First open-close channel diagnostic cycle' },
  rlnOpenCloseCycle2: { label: 'Open/Close Cycle 2', desc: 'Second open-close channel diagnostic cycle' },
  // ── Payment flow steps ────────────────────────────────────────────────────
  payACreateNode: { label: 'Pay Node A Create', desc: 'Create RLN node A for payment flow' },
  payAInitNode: { label: 'Pay Node A Init', desc: 'Initialize payment node A' },
  payAUnlockNode: { label: 'Pay Node A Unlock', desc: 'Unlock payment node A' },
  payBCreateNode: { label: 'Pay Node B Create', desc: 'Create RLN node B for payment flow' },
  payBInitNode: { label: 'Pay Node B Init', desc: 'Initialize payment node B' },
  payBUnlockNode: { label: 'Pay Node B Unlock', desc: 'Unlock payment node B' },
  payCCreateNode: { label: 'Pay Node C Create', desc: 'Create RLN node C for payment flow' },
  payCInitNode: { label: 'Pay Node C Init', desc: 'Initialize payment node C' },
  payCUnlockNode: { label: 'Pay Node C Unlock', desc: 'Unlock payment node C' },
  payAFund: { label: 'Pay Node A Fund', desc: 'Fund payment node A with BTC' },
  payACreateUtxos: { label: 'Pay Node A UTXOs', desc: 'Create UTXOs for payment node A' },
  payBFund: { label: 'Pay Node B Fund', desc: 'Fund payment node B with BTC' },
  payBCreateUtxos: { label: 'Pay Node B UTXOs', desc: 'Create UTXOs for payment node B' },
  payCFund: { label: 'Pay Node C Fund', desc: 'Fund payment node C with BTC' },
  payCCreateUtxos: { label: 'Pay Node C UTXOs', desc: 'Create UTXOs for payment node C' },
  payNodeInfos: { label: 'Pay Node Infos', desc: 'Fetch pubkeys for payment nodes A and B' },
  payConnectPeers: { label: 'Pay Connect Peers', desc: 'Connect B→A and C→B peers' },
  payOpenChannel: { label: 'Pay Open Channel', desc: 'B opens channel to A; wait for funding confirmation' },
  payCreateInvoices: { label: 'Pay Create Invoices', desc: 'A creates 4 invoices concurrently' },
  paySendPayment1: { label: 'Pay Send Payment 1', desc: 'B sends first payment to A (10k msat)' },
  payWaitInvoice1: { label: 'Pay Wait Invoice 1', desc: 'Wait for invoice 1 SUCCEEDED on A' },
  payWaitSender1: { label: 'Pay Wait Sender 1', desc: 'Wait for payment 1 success on B' },
  paySendPayment2: { label: 'Pay Send Payment 2', desc: 'B sends second payment to A (20k msat)' },
  payWaitInvoice2: { label: 'Pay Wait Invoice 2', desc: 'Wait for invoice 2 SUCCEEDED on A' },
  payWaitSender2: { label: 'Pay Wait Sender 2', desc: 'Wait for payment 2 success on B' },
  paySendPayment3: { label: 'Pay Send Payment 3', desc: 'B sends third payment to A (30k msat)' },
  payWaitInvoice3: { label: 'Pay Wait Invoice 3', desc: 'Wait for invoice 3 SUCCEEDED on A' },
  payWaitSender3: { label: 'Pay Wait Sender 3', desc: 'Wait for payment 3 success on B' },
  paySendPayment4: { label: 'Pay Send Payment 4', desc: 'B sends fourth payment to A (40k msat)' },
  payWaitInvoice4: { label: 'Pay Wait Invoice 4', desc: 'Wait for invoice 4 SUCCEEDED on A' },
  payWaitSender4: { label: 'Pay Wait Sender 4', desc: 'Wait for payment 4 success on B' },
  payCloseChannel: { label: 'Pay Close Channel', desc: 'Force close channel and mine confirmation blocks' },
  payFinalBalance: { label: 'Pay Final Balance', desc: 'Read final BTC balance on node A' },
  // ── Restart flow steps ────────────────────────────────────────────────────
  restartACreateNode: { label: 'Restart Node A Create', desc: 'Create RLN node A for restart flow' },
  restartAInitNode: { label: 'Restart Node A Init', desc: 'Initialize restart node A' },
  restartAUnlockNode: { label: 'Restart Node A Unlock', desc: 'Unlock restart node A' },
  restartBCreateNode: { label: 'Restart Node B Create', desc: 'Create RLN node B for restart flow' },
  restartBInitNode: { label: 'Restart Node B Init', desc: 'Initialize restart node B' },
  restartBUnlockNode: { label: 'Restart Node B Unlock', desc: 'Unlock restart node B' },
  restartCCreateNode: { label: 'Restart Node C Create', desc: 'Create RLN node C for restart flow' },
  restartCInitNode: { label: 'Restart Node C Init', desc: 'Initialize restart node C' },
  restartCUnlockNode: { label: 'Restart Node C Unlock', desc: 'Unlock restart node C' },
  restartAFund: { label: 'Restart Node A Fund', desc: 'Fund restart node A with BTC' },
  restartACreateUtxos: { label: 'Restart Node A UTXOs', desc: 'Create UTXOs for restart node A' },
  restartBFund: { label: 'Restart Node B Fund', desc: 'Fund restart node B with BTC' },
  restartBCreateUtxos: { label: 'Restart Node B UTXOs', desc: 'Create UTXOs for restart node B' },
  restartCFund: { label: 'Restart Node C Fund', desc: 'Fund restart node C with BTC' },
  restartCCreateUtxos: { label: 'Restart Node C UTXOs', desc: 'Create UTXOs for restart node C' },
  restartNodeInfos: { label: 'Restart Node Infos', desc: 'Fetch pubkeys for restart nodes A and B' },
  restartConnectPeer: { label: 'Restart Connect Peer', desc: 'Connect B→A peer' },
  restartOpenChannel: { label: 'Restart Open Channel', desc: 'A opens channel to B; wait for funding' },
  restartPreRestartPayment: { label: 'Restart Pre-Restart Payment', desc: 'A pays B before restart' },
  restartShutdownA: { label: 'Restart Shutdown A', desc: 'Shutdown node A for restart' },
  restartShutdownB: { label: 'Restart Shutdown B', desc: 'Shutdown node B for restart' },
  restartShutdownC: { label: 'Restart Shutdown C', desc: 'Shutdown node C for restart' },
  restartARecreateCreateNode: { label: 'Restart A Recreate Create', desc: 'Recreate node A after shutdown' },
  restartARecreateInitNode: { label: 'Restart A Recreate Init', desc: 'Re-init node A after shutdown' },
  restartARecreateUnlockNode: { label: 'Restart A Recreate Unlock', desc: 'Re-unlock node A after shutdown' },
  restartBRecreateCreateNode: { label: 'Restart B Recreate Create', desc: 'Recreate node B after shutdown' },
  restartBRecreateInitNode: { label: 'Restart B Recreate Init', desc: 'Re-init node B after shutdown' },
  restartBRecreateUnlockNode: { label: 'Restart B Recreate Unlock', desc: 'Re-unlock node B after shutdown' },
  restartCRecreateCreateNode: { label: 'Restart C Recreate Create', desc: 'Recreate node C after shutdown' },
  restartCRecreateInitNode: { label: 'Restart C Recreate Init', desc: 'Re-init node C after shutdown' },
  restartCRecreateUnlockNode: { label: 'Restart C Recreate Unlock', desc: 'Re-unlock node C after shutdown' },
  restartWaitUsableChannel: { label: 'Restart Wait Usable Channel', desc: 'Wait for channel to become usable after restart' },
  restartVerifyPayment: { label: 'Restart Verify Payment', desc: 'Confirm pre-restart payment survived' },
  // ── Multi open/close flow steps ───────────────────────────────────────────
  mocACreateNode: { label: 'MOC Node A Create', desc: 'Create RLN node A for multi open/close flow' },
  mocAInitNode: { label: 'MOC Node A Init', desc: 'Initialize multi open/close node A' },
  mocAUnlockNode: { label: 'MOC Node A Unlock', desc: 'Unlock multi open/close node A' },
  mocBCreateNode: { label: 'MOC Node B Create', desc: 'Create RLN node B for multi open/close flow' },
  mocBInitNode: { label: 'MOC Node B Init', desc: 'Initialize multi open/close node B' },
  mocBUnlockNode: { label: 'MOC Node B Unlock', desc: 'Unlock multi open/close node B' },
  mocCCreateNode: { label: 'MOC Node C Create', desc: 'Create RLN node C for multi open/close flow' },
  mocCInitNode: { label: 'MOC Node C Init', desc: 'Initialize multi open/close node C' },
  mocCUnlockNode: { label: 'MOC Node C Unlock', desc: 'Unlock multi open/close node C' },
  mocAFund: { label: 'MOC Node A Fund', desc: 'Fund multi open/close node A' },
  mocACreateUtxos: { label: 'MOC Node A UTXOs', desc: 'Create UTXOs for multi open/close node A' },
  mocBFund: { label: 'MOC Node B Fund', desc: 'Fund multi open/close node B' },
  mocBCreateUtxos: { label: 'MOC Node B UTXOs', desc: 'Create UTXOs for multi open/close node B' },
  mocCFund: { label: 'MOC Node C Fund', desc: 'Fund multi open/close node C' },
  mocCCreateUtxos: { label: 'MOC Node C UTXOs', desc: 'Create UTXOs for multi open/close node C' },
  mocNodeInfos: { label: 'MOC Node Infos', desc: 'Fetch pubkeys for nodes A and B' },
  mocConnectPeers: { label: 'MOC Connect Peers', desc: 'Connect B→A and C→B peers' },
  mocOpenChannel1: { label: 'MOC Open Channel 1', desc: 'B opens channel to A — cycle 1' },
  mocKeysend1: { label: 'MOC Keysend 1', desc: 'A keysends 1000 sat to B — cycle 1' },
  mocBalanceCheck1: { label: 'MOC Balance Check 1', desc: 'Check BTC balances after keysend — cycle 1' },
  mocCloseChannel1: { label: 'MOC Close Channel 1', desc: 'Cooperative close channel — cycle 1' },
  mocOpenChannel2: { label: 'MOC Open Channel 2', desc: 'B opens channel to A — cycle 2' },
  mocKeysend2: { label: 'MOC Keysend 2', desc: 'A keysends 1000 sat to B — cycle 2' },
  mocBalanceCheck2: { label: 'MOC Balance Check 2', desc: 'Check BTC balances after keysend — cycle 2' },
  mocCloseChannel2: { label: 'MOC Close Channel 2', desc: 'Cooperative close channel — cycle 2' },
  // ── Concurrent BTC payments flow steps ───────────────────────────────────
  cbpACreateNode: { label: 'CBP Node A Create', desc: 'Create RLN node A for concurrent payments flow' },
  cbpAInitNode: { label: 'CBP Node A Init', desc: 'Initialize concurrent payments node A' },
  cbpAUnlockNode: { label: 'CBP Node A Unlock', desc: 'Unlock concurrent payments node A' },
  cbpBCreateNode: { label: 'CBP Node B Create', desc: 'Create RLN node B for concurrent payments flow' },
  cbpBInitNode: { label: 'CBP Node B Init', desc: 'Initialize concurrent payments node B' },
  cbpBUnlockNode: { label: 'CBP Node B Unlock', desc: 'Unlock concurrent payments node B' },
  cbpCCreateNode: { label: 'CBP Node C Create', desc: 'Create RLN node C for concurrent payments flow' },
  cbpCInitNode: { label: 'CBP Node C Init', desc: 'Initialize concurrent payments node C' },
  cbpCUnlockNode: { label: 'CBP Node C Unlock', desc: 'Unlock concurrent payments node C' },
  cbpDCreateNode: { label: 'CBP Node D Create', desc: 'Create RLN node D for concurrent payments flow' },
  cbpDInitNode: { label: 'CBP Node D Init', desc: 'Initialize concurrent payments node D' },
  cbpDUnlockNode: { label: 'CBP Node D Unlock', desc: 'Unlock concurrent payments node D' },
  cbpAFund: { label: 'CBP Node A Fund', desc: 'Fund concurrent payments node A' },
  cbpACreateUtxos: { label: 'CBP Node A UTXOs', desc: 'Create UTXOs for concurrent payments node A' },
  cbpBFund: { label: 'CBP Node B Fund', desc: 'Fund concurrent payments node B' },
  cbpBCreateUtxos: { label: 'CBP Node B UTXOs', desc: 'Create UTXOs for concurrent payments node B' },
  cbpCFund: { label: 'CBP Node C Fund', desc: 'Fund concurrent payments node C' },
  cbpCCreateUtxos: { label: 'CBP Node C UTXOs', desc: 'Create UTXOs for concurrent payments node C' },
  cbpDFund: { label: 'CBP Node D Fund', desc: 'Fund concurrent payments node D' },
  cbpDCreateUtxos: { label: 'CBP Node D UTXOs', desc: 'Create UTXOs for concurrent payments node D' },
  cbpNodeInfos: { label: 'CBP Node Infos', desc: 'Fetch pubkeys for nodes A and B' },
  cbpConnectPeers: { label: 'CBP Connect Peers', desc: 'Connect B→A, C→B, D→B peers' },
  cbpOpenChannelBtoA: { label: 'CBP Open Channel B→A', desc: 'B opens channel to A (routing channel)' },
  cbpOpenChannelCtoB: { label: 'CBP Open Channel C→B', desc: 'C opens channel to B' },
  cbpOpenChannelDtoB: { label: 'CBP Open Channel D→B', desc: 'D opens channel to B' },
  cbpCreateInvoices: { label: 'CBP Create Invoices', desc: 'A creates 2 invoices concurrently' },
  cbpConcurrentSend: { label: 'CBP Concurrent Send', desc: 'C and D send payments to A concurrently' },
  cbpWaitInvoice1: { label: 'CBP Wait Invoice 1', desc: 'Wait for invoice 1 SUCCEEDED on A' },
  cbpWaitInvoice2: { label: 'CBP Wait Invoice 2', desc: 'Wait for invoice 2 SUCCEEDED on A' },
  cbpWaitSenders: { label: 'CBP Wait Senders', desc: 'Wait for both C and D payments to succeed' },
  cbpFinalBalance: { label: 'CBP Final Balance', desc: 'Read final BTC balance on node A' },
  swapNodeACreateNode: { label: 'Swap Node A Create', desc: 'Create maker node A' },
  swapNodeAInitNode: { label: 'Swap Node A Init', desc: 'Initialize maker node A' },
  swapNodeAUnlockNode: { label: 'Swap Node A Unlock', desc: 'Unlock maker node A' },
  swapNodeBCreateNode: { label: 'Swap Node B Create', desc: 'Create taker node B' },
  swapNodeBInitNode: { label: 'Swap Node B Init', desc: 'Initialize taker node B' },
  swapNodeBUnlockNode: { label: 'Swap Node B Unlock', desc: 'Unlock taker node B' },
  swapNodeAFund: { label: 'Swap Node A Fund', desc: 'Fund node A with BTC' },
  swapNodeBFund: { label: 'Swap Node B Fund', desc: 'Fund node B with BTC' },
  swapNodeACreateUtxos: { label: 'Swap Node A UTXOs', desc: 'Create UTXOs for node A' },
  swapNodeBCreateUtxos: { label: 'Swap Node B UTXOs', desc: 'Create UTXOs for node B' },
  swapIssueAsset: { label: 'Swap Issue Asset', desc: 'Issue test asset for swap' },
  swapOpenChannels: { label: 'Swap Open Channels', desc: 'Open asset and BTC channels between nodes' },
  swapExecuteRoundtrip: { label: 'Swap Execute', desc: 'Run makerinit -> taker -> makerexecute sequence' },
  swapPostChecks: { label: 'Swap Post Checks', desc: 'Validate swap and balances after execution' },
  swapCloseChannels: { label: 'Swap Close Channels', desc: 'Close swap test channels' },
  // ── External signer issue asset flow steps ────────────────────────────────
  extIssueCreateNode: { label: 'Create Node', desc: 'Create RLN node with external signer' },
  extIssueCreateExternalSigner: { label: 'Create External Signer', desc: 'Create native external signer from BIP39 seed' },
  extIssueInitNode: { label: 'Init Node', desc: 'Initialize node using native external signer' },
  extIssueUnlockNode: { label: 'Unlock Node', desc: 'Unlock node using native external signer' },
  extIssueNodeInfoAfter: { label: 'Node Info (after unlock)', desc: 'Read node info after unlock' },
  extIssueFund: { label: 'Fund Node', desc: 'Fund node with BTC and mine confirmation blocks' },
  extIssueCreateUtxos: { label: 'Create UTXOs', desc: 'Create UTXOs for RGB asset operations' },
  extIssueAsset: { label: 'Issue Asset', desc: 'Issue NIA asset using external signer node' },
  // ── External signer channel payment flow steps ────────────────────────────
  extChanACreateNode: { label: 'Node A Create', desc: 'Create nodeA with external signer' },
  extChanACreateExternalSigner: { label: 'Node A Create Signer', desc: 'Create native external signer for nodeA' },
  extChanAInitNode: { label: 'Node A Init', desc: 'Init nodeA with external signer' },
  extChanAUnlockNode: { label: 'Node A Unlock', desc: 'Unlock nodeA with external signer' },
  extChanBCreateNode: { label: 'Node B Create', desc: 'Create nodeB with password auth' },
  extChanBInitNode: { label: 'Node B Init', desc: 'Init nodeB with password' },
  extChanBUnlockNode: { label: 'Node B Unlock', desc: 'Unlock nodeB with password' },
  extChanAFund: { label: 'Node A Fund', desc: 'Fund nodeA' },
  extChanACreateUtxos: { label: 'Node A UTXOs', desc: 'Create UTXOs for nodeA' },
  extChanBFund: { label: 'Node B Fund', desc: 'Fund nodeB' },
  extChanBCreateUtxos: { label: 'Node B UTXOs', desc: 'Create UTXOs for nodeB' },
  extChanNodeInfos: { label: 'Node Infos', desc: 'Fetch pubkeys for both nodes' },
  extChanConnectPeers: { label: 'Connect Peers', desc: 'NodeA connects to nodeB' },
  extChanOpenChannel: { label: 'Open BTC Channel', desc: 'Open 500k sat BTC channel nodeA→nodeB' },
  extChanPayment1: { label: 'Payment 1', desc: 'NodeB invoice, nodeA pays (3M msat)' },
  extChanRestartNodeA: { label: 'Restart NodeA', desc: 'Shutdown and restart nodeA with same external signer' },
  extChanPayment2: { label: 'Payment 2', desc: 'Second payment after nodeA restart' },
  // ── UTEXOWallet channel payment flow steps ─────────────────────────────
  wPayAInit: { label: 'Node A Init', desc: 'UTEXOWallet.init() — createNode + PasswordRLNSigner' },
  wPayAUnlock: { label: 'Node A Unlock', desc: 'UTEXOWallet.unlock() — PasswordRLNSigner injects password' },
  wPayBInit: { label: 'Node B Init', desc: 'UTEXOWallet.init() — createNode + PasswordRLNSigner' },
  wPayBUnlock: { label: 'Node B Unlock', desc: 'UTEXOWallet.unlock() — PasswordRLNSigner injects password' },
  wPayCInit: { label: 'Node C Init', desc: 'UTEXOWallet.init() — createNode + PasswordRLNSigner' },
  wPayCUnlock: { label: 'Node C Unlock', desc: 'UTEXOWallet.unlock() — PasswordRLNSigner injects password' },
  wPayAFund: { label: 'Fund Node A', desc: 'getAddress() + sendToAddress + mine 6' },
  wPayACreateUtxos: { label: 'Node A UTXOs', desc: 'createUtxos() num=10 feeRate=7' },
  wPayBFund: { label: 'Fund Node B', desc: 'getAddress() + sendToAddress + mine 6' },
  wPayBCreateUtxos: { label: 'Node B UTXOs', desc: 'createUtxos() num=10 feeRate=7' },
  wPayCFund: { label: 'Fund Node C', desc: 'getAddress() + sendToAddress + mine 6' },
  wPayCCreateUtxos: { label: 'Node C UTXOs', desc: 'createUtxos() num=10 feeRate=7' },
  wPayIssueAsset: { label: 'Issue Asset', desc: 'nodeA.issueAssetNia() — 1000 USDT' },
  wPayNodeInfos: { label: 'Node Infos', desc: 'getNodeInfo() on nodeA and nodeB' },
  wPayConnectPeers: { label: 'Connect Peers', desc: 'nodeA.connectPeer(nodeB)' },
  wPayOpenChannel: { label: 'Open Asset Channel', desc: 'openChannel() 600 asset units, 100k sat nodeA→nodeB' },
  wPayAssetBalanceA: { label: 'Asset Balance A', desc: 'getAssetBalance() — nodeA spendable after open (≈400)' },
  wPayInvoice1: { label: 'Payment 1 (B→A)', desc: 'nodeB.createLightningInvoice(100 units), nodeA.payLightningInvoice()' },
  wPayInvoice2: { label: 'Payment 2 (A→B)', desc: 'nodeA.createLightningInvoice(50 units), nodeB.payLightningInvoice()' },
  wPayInvoice3: { label: 'Payment 3 (B→A)', desc: 'nodeB.createLightningInvoice(50 units), nodeA.payLightningInvoice()' },
  wPayInvoice4: { label: 'Payment 4 (A→B)', desc: 'nodeA.createLightningInvoice(50 units), nodeB.payLightningInvoice()' },
  wPayCloseChannel: { label: 'Close Channel', desc: 'nodeA.closeChannel() cooperative — mine + refreshWallet x3' },
  wPayWaitBalances: { label: 'Wait Balances A+B', desc: 'Poll getAssetBalance() until A=950, B=50' },
  wPayRgbSendA: { label: 'RGB Send A→C', desc: 'nodeC.blindReceive(), nodeA.send() 925 units on-chain' },
  wPayRgbSendB: { label: 'RGB Send B→C', desc: 'nodeC.blindReceive(), nodeB.send() 25 units on-chain' },
  wPayFinalBalances: { label: 'Final Balances', desc: 'getAssetBalance() on all 3 nodes — A=25, B=25, C=950' },
  wChanAInit: { label: 'Node A Init', desc: 'UTEXOWallet.init() — createNode + external signer setup' },
  wChanAUnlock: { label: 'Node A Unlock', desc: 'UTEXOWallet.unlock() — NativeExternalRLNSigner' },
  wChanBInit: { label: 'Node B Init', desc: 'UTEXOWallet.init() — createNode + password signer setup' },
  wChanBUnlock: { label: 'Node B Unlock', desc: 'UTEXOWallet.unlock() — PasswordRLNSigner injects password' },
  wChanNodeInfos: { label: 'Node Infos', desc: 'Fetch pubkeys via getNodeInfo()' },
  wChanAFund: { label: 'Node A Fund', desc: 'Fund nodeA via getAddress() + sendToAddress + mine' },
  wChanACreateUtxos: { label: 'Node A UTXOs', desc: 'createUtxos() for nodeA' },
  wChanBFund: { label: 'Node B Fund', desc: 'Fund nodeB via getAddress() + sendToAddress + mine' },
  wChanBCreateUtxos: { label: 'Node B UTXOs', desc: 'createUtxos() for nodeB' },
  wChanConnectPeers: { label: 'Connect Peers', desc: 'nodeA.connectPeer(nodeB)' },
  wChanOpenChannel: { label: 'Open BTC Channel', desc: 'openChannel() 500k sat nodeA→nodeB' },
  wChanPayment1: { label: 'Payment 1', desc: 'nodeB.createLightningInvoice(), nodeA.payLightningInvoice()' },
  wChanRestartNodeA: { label: 'Restart NodeA', desc: 'nodeA.shutdown() + nodeA.reinit() — same instance, no manager swap' },
  wChanPayment2: { label: 'Payment 2', desc: 'Second payment after nodeA restart' },
  wAsExtAInit: { label: 'Node A Init', desc: 'UTEXOWallet.init() — createNode + PasswordRLNSigner (regular)' },
  wAsExtAUnlock: { label: 'Node A Unlock', desc: 'UTEXOWallet.unlock() — PasswordRLNSigner injects password' },
  wAsExtBInit: { label: 'Node B Init', desc: 'UTEXOWallet.init() — createNode + NativeExternalRLNSigner' },
  wAsExtBUnlock: { label: 'Node B Unlock', desc: 'UTEXOWallet.unlock() — NativeExternalRLNSigner' },
  wAsExtNodeInfos: { label: 'Node Infos', desc: 'Fetch pubkeys via getNodeInfo() on both nodes' },
  wAsExtAFund: { label: 'Fund Node A', desc: 'getAddress() + sendToAddress + mine 6' },
  wAsExtACreateUtxos: { label: 'Node A UTXOs', desc: 'createUtxos() num=10 feeRate=7' },
  wAsExtBFund: { label: 'Fund Node B', desc: 'getAddress() + sendToAddress + mine 6' },
  wAsExtBCreateUtxos: { label: 'Node B UTXOs', desc: 'createUtxos() num=10 feeRate=7' },
  wAsExtIssueAsset: { label: 'Issue Asset', desc: 'nodeA (regular).issueAssetNia() — 1000 USDT' },
  wAsExtConnectPeers: { label: 'Connect Peers', desc: 'nodeA.connectPeer(nodeB)' },
  wAsExtOpenChannel: { label: 'Open Asset Channel', desc: 'nodeA.openChannel() 600 asset units, 100k sat, private nodeA→nodeB' },
  wAsExtPayment1: { label: 'Payment 1', desc: 'nodeB (ext signer).createLightningInvoice(100 units), nodeA.payLightningInvoice()' },
  wAsExtRestartNodeA: { label: 'Restart NodeA', desc: 'nodeA.shutdown() + nodeA.reinit() — same instance, no manager swap' },
  wAsExtPayment2: { label: 'Payment 2', desc: 'nodeB (ext signer).createLightningInvoice(50 units), nodeA pays after restart' },
  wAsExtCloseChannel: { label: 'Close Channel', desc: 'nodeA.closeChannel() cooperative — mine + refreshWallet ×3' },
  wAsExtWaitBalances: { label: 'Wait Balances A+B', desc: 'Poll getAssetBalance() until A=850, B=150' },
  wAsExtRevConnectPeers: { label: 'Reconnect Peers Rev', desc: 'nodeB (signer).connectPeer(nodeA) before reverse channel' },
  wAsExtRevOpenChannel: { label: 'Open Channel Rev', desc: 'nodeB (signer).openChannel() 100 asset units to nodeA — nodeB off-chain=50' },
  wAsExtRevPayment: { label: 'Payment Rev', desc: 'nodeA.createLightningInvoice(50 units), nodeB (signer).payLightningInvoice()' },
  wAsExtRevCloseChannel: { label: 'Close Channel Rev', desc: 'nodeA.closeChannel() cooperative — mine + refreshWallet ×3' },
  wAsExtRevWaitBalances: { label: 'Wait Balances Rev', desc: 'Poll getAssetBalance() until A=900, B=100' },
  wAsExtRgbSendBtoA: { label: 'RGB Send B→A', desc: 'nodeA.blindReceive(), nodeB.send() 150 units on-chain back to nodeA' },
  wAsExtFinalBalances: { label: 'Final Balances', desc: 'getAssetBalance() on both nodes — A=1000, B=0' },
  xPayAInit: { label: 'Node A Init', desc: 'UTEXOWallet.init() — createNode + PasswordRLNSigner' },
  xPayAUnlock: { label: 'Node A Unlock', desc: 'UTEXOWallet.unlock() — PasswordRLNSigner' },
  xPayBInit: { label: 'Node B Init', desc: 'UTEXOWallet.init() — createNode + NativeExternalRLNSigner' },
  xPayBUnlock: { label: 'Node B Unlock', desc: 'UTEXOWallet.unlock() — NativeExternalRLNSigner (VLS in-process)' },
  xPayCInit: { label: 'Node C Init', desc: 'UTEXOWallet.init() — createNode + PasswordRLNSigner' },
  xPayCUnlock: { label: 'Node C Unlock', desc: 'UTEXOWallet.unlock() — PasswordRLNSigner' },
  xPayAFund: { label: 'Fund Node A', desc: 'getAddress() + sendToAddress + mine 6' },
  xPayACreateUtxos: { label: 'Node A UTXOs', desc: 'createUtxos() num=10 feeRate=7' },
  xPayBFund: { label: 'Fund Node B', desc: 'getAddress() + sendToAddress + mine 6' },
  xPayBCreateUtxos: { label: 'Node B UTXOs', desc: 'createUtxos() num=10 feeRate=7' },
  xPayCFund: { label: 'Fund Node C', desc: 'getAddress() + sendToAddress + mine 6' },
  xPayCCreateUtxos: { label: 'Node C UTXOs', desc: 'createUtxos() num=10 feeRate=7' },
  xPayIssueAsset: { label: 'Issue Asset', desc: 'nodeA.issueAssetNia() — 1000 USDT' },
  xPayNodeInfos: { label: 'Node Infos', desc: 'Fetch pubkeys via getNodeInfo() on nodeA + nodeB' },
  xPayConnectPeers: { label: 'Connect Peers', desc: 'nodeA.connectPeer(nodeB)' },
  xPayOpenChannel: { label: 'Open Asset Channel', desc: 'nodeA.openChannel() 600 units, 100k sat, pushMsat=0 (ext signer acceptor)' },
  xPayAssetBalanceA: { label: 'Asset Balance A', desc: 'getAssetBalance() — nodeA spendable after open (≈400)' },
  xPayInvoice1: { label: 'Payment 1 (B→A)', desc: 'nodeB (ext).createLightningInvoice(100 units, 5000 sat), nodeA pays — 5000 sat so B has reserve headroom for inv2' },
  xPayInvoice2: { label: 'Payment 2 (A→B)', desc: 'nodeA.createLightningInvoice(50 units, 3000 sat), nodeB (ext) pays — RGB min 3000 sat; B has 5000−3000=2000 ≥ 1000 reserve' },
  xPayInvoice3: { label: 'Payment 3 (B→A)', desc: 'nodeB (ext).createLightningInvoice(50 units, 5000 sat), nodeA pays — refills B sats for inv4' },
  xPayInvoice4: { label: 'Payment 4 (A→B)', desc: 'nodeA.createLightningInvoice(50 units, 3000 sat), nodeB (ext) pays — B has 7000 sats, comfortably above reserve' },
  xPayCloseChannel: { label: 'Close Channel', desc: 'nodeA.closeChannel() cooperative — mine + refreshWallet ×3' },
  xPayWaitBalances: { label: 'Wait Balances A+B', desc: 'Poll getAssetBalance() until A=950, B=50 (5-min deadline for force-close sweep)' },
  xPayRgbSendA: { label: 'RGB Send A→C', desc: 'nodeC.blindReceive(), nodeA.send() 925 units on-chain' },
  xPayRgbSendB: { label: 'RGB Send B→C', desc: 'nodeC.blindReceive(), nodeB (ext).send() 25 units on-chain' },
  xPayFinalBalances: { label: 'Final Balances', desc: 'getAssetBalance() on all 3 nodes — A=25, B=25, C=950' },
  extOsAInit: { label: 'Node A Init', desc: 'UTEXOWallet.init() — NativeExternalRLNSigner (ext signer)' },
  extOsAUnlock: { label: 'Node A Unlock', desc: 'UTEXOWallet.unlock() — NativeExternalRLNSigner' },
  extOsBInit: { label: 'Node B Init', desc: 'UTEXOWallet.init() — PasswordRLNSigner' },
  extOsBUnlock: { label: 'Node B Unlock', desc: 'UTEXOWallet.unlock() — PasswordRLNSigner' },
  extOsAFund: { label: 'Fund Node A', desc: 'getAddress() + sendToAddress + mine 6' },
  extOsACreateUtxos: { label: 'Node A UTXOs', desc: 'createUtxos() num=10 feeRate=7 (ext signer PSBT path)' },
  extOsBFund: { label: 'Fund Node B', desc: 'getAddress() + sendToAddress + mine 6' },
  extOsBCreateUtxos: { label: 'Node B UTXOs', desc: 'createUtxos() num=10 feeRate=7' },
  extOsIssueAsset: { label: 'Issue Asset', desc: 'nodeB (password).issueAssetNia() — 1000 XSND (issuance blocked in ext signer mode)' },
  extOsSendToExt: { label: 'Send → Ext Signer', desc: 'nodeA (ext).blindReceive(), nodeB (pwd).send() 500 units on-chain → nodeA' },
  extOsWaitExtBalance: { label: 'Wait nodeA Balance', desc: 'Poll nodeA.getAssetBalance() until spendable=500' },
  extOsSendFromExt: { label: 'Send ← Ext Signer', desc: 'nodeB (pwd).blindReceive(), nodeA (ext).send() 250 units — rgb_send_begin→rgb_sign_psbt→rgb_send_end' },
  extOsFinalBalances: { label: 'Final Balances', desc: 'getAssetBalance() — expected nodeA=250, nodeB=750' },
  // ── Mainnet init flow steps ───────────────────────────────────────────────
  mainnetInitNode: { label: 'Init Node', desc: 'UTEXOWallet.init() — createNode + PasswordRLNSigner on mainnet' },
  mainnetUnlockNode: { label: 'Unlock Node', desc: 'UTEXOWallet.unlock() — mainnet indexer/proxy endpoints' },
  mainnetGetAddress: { label: 'Get Address', desc: 'getAddress() — derive a mainnet receive address' },
};

// ─── Wallet flow step meta ────────────────────────────────────────────────────

const UTEXO_VSS_STEP_META: Record<string, { label: string; desc: string }> = {
  createUtexoWallet:    { label: 'Create UTEXO Wallet',   desc: 'Instantiate & initialise UTEXOWallet with VSS' },
  getAddress:           { label: 'Get Deposit Address',   desc: 'Derive a receive address' },
  fundWallet:           { label: 'Fund via Faucet',       desc: 'Send sats from thunderstack faucet' },
  waitForFunding:       { label: 'Wait for Balance',      desc: 'Poll until balance > 0' },
  createUtxos:          { label: 'Create UTXOs',          desc: 'Allocate UTXOs for RGB operations' },
  issueAssetNia:        { label: 'Issue NIA Asset',       desc: 'Issue VDMO token on UTEXO layer' },
  listAssets:           { label: 'List Assets',           desc: 'Confirm asset appears in list' },
  getAssetBalance:      { label: 'Get Asset Balance',     desc: 'Record pre-wipe asset balance' },
  disposeWallet:        { label: 'Dispose Wallet',        desc: 'Close wallet — VSS KV already replicated' },
  deleteState:          { label: 'Delete Local State',    desc: 'Wipe storage, prepare restore directory' },
  restoreFromVss:       { label: 'Restore from VSS',      desc: 'New wallet instance, same mnemonic — downloads LDK state' },
  verifyRestoredWallet: { label: 'Verify Restored State', desc: 'Compare pubkey and asset balance' },
  cleanup:              { label: 'Cleanup',               desc: 'Dispose restored wallet' },
};

const RLN_VSS_STEP_META: Record<string, { label: string; desc: string }> = {
  vssCreateWallet:      { label: 'Create Wallet',         desc: 'Instantiate & unlock UTEXOWallet with VSS on regtest' },
  vssGetAddress:        { label: 'Get Address',           desc: 'Derive a receive address' },
  vssFundWallet:        { label: 'Fund Wallet',           desc: 'sendToAddress(1 BTC) + mine(6)' },
  vssCreateUtxos:       { label: 'Create UTXOs',          desc: 'Allocate UTXOs for RGB operations + mine(1)' },
  vssIssueAssetNia:     { label: 'Issue NIA Asset',       desc: 'Issue 500 VDMO tokens on regtest' },
  vssListAssets:        { label: 'List Assets',           desc: 'Confirm asset appears in list' },
  vssGetAssetBalance:   { label: 'Asset Balance',         desc: 'Record pre-wipe spendable balance' },
  vssDisposeWallet:     { label: 'Dispose Wallet',        desc: 'Close wallet — VSS KV already replicated' },
  vssDeleteState:       { label: 'Delete Local State',    desc: 'Wipe storage, prepare restore directory' },
  vssRestoreFromVss:    { label: 'Restore from VSS',      desc: 'New wallet instance, same mnemonic — downloads LDK state' },
  vssVerifyRestoredWallet: { label: 'Verify Restored',   desc: 'Compare pubkey and asset balance' },
  vssCleanup:           { label: 'Cleanup',               desc: 'Dispose restored wallet' },
};

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function FlowsScreen() {
  const [activeTab, setActiveTab] = useState<'regtest' | 'utexo' | 'mainnet'>('regtest');

  const [rlnWalletChanPayResults, setRlnWalletChanPayResults] = useState<FlowResults>(null);
  const [runningRlnWalletChanPayFlow, setRunningRlnWalletChanPayFlow] = useState(false);
  const rlnWalletChanPayInFlightRef = useRef(false);
  const [rlnUtexoPayResults, setRlnUtexoPayResults] = useState<FlowResults>(null);
  const [runningRlnUtexoPayFlow, setRunningRlnUtexoPayFlow] = useState(false);
  const rlnUtexoPayInFlightRef = useRef(false);
  const [rlnAssetExtResults, setRlnAssetExtResults] = useState<FlowResults>(null);
  const [runningRlnAssetExtFlow, setRunningRlnAssetExtFlow] = useState(false);
  const rlnAssetExtInFlightRef = useRef(false);
  const [rlnExtPayResults, setRlnExtPayResults] = useState<FlowResults>(null);
  const [runningRlnExtPayFlow, setRunningRlnExtPayFlow] = useState(false);
  const rlnExtPayInFlightRef = useRef(false);
  const [extOsSendResults, setExtOsSendResults] = useState<FlowResults>(null);
  const [runningExtOsSendFlow, setRunningExtOsSendFlow] = useState(false);
  const extOsSendInFlightRef = useRef(false);
  const [vssFlowResults, setVssFlowResults] = useState<FlowResults>(null);
  const [runningVssFlow, setRunningVssFlow] = useState(false);
  const vssFlowInFlightRef = useRef(false);
  const [rlnVssFlowResults, setRlnVssFlowResults] = useState<FlowResults>(null);
  const [runningRlnVssFlow, setRunningRlnVssFlow] = useState(false);
  const rlnVssFlowInFlightRef = useRef(false);
  const [mainnetInitResults, setMainnetInitResults] = useState<FlowResults>(null);
  const [runningMainnetInitFlow, setRunningMainnetInitFlow] = useState(false);
  const mainnetInitInFlightRef = useRef(false);
  const activeUnlockParams = activeTab === 'regtest'
    ? buildRegtestConfig().unlockParams
    : activeTab === 'mainnet'
    ? buildMainnetConfig().unlockParams
    : buildUtexoConfig().unlockParams;
  const activeUnlockRows: [string, string][] = [
    ['host', `${activeUnlockParams.bitcoindRpcHost ?? '(default)'}:${activeUnlockParams.bitcoindRpcPort ?? '(default)'}`],
    ['indexer', activeUnlockParams.indexerUrl ?? '(network default)'],
    ['proxy', activeUnlockParams.proxyEndpoint ?? '(network default)'],
  ];


  // ── Flow handlers ─────────────────────────────────────────────────────────


  async function handleRlnWalletChanPayFlow() {
    if (rlnWalletChanPayInFlightRef.current) return;
    rlnWalletChanPayInFlightRef.current = true;
    try {
      setRunningRlnWalletChanPayFlow(true);
      setRlnWalletChanPayResults({ running: true, steps: [] });
      const r = await runRlnUtexoWalletChannelPaymentFlow();
      setRlnWalletChanPayResults({ ...r, running: false });
    } catch (e: any) {
      setRlnWalletChanPayResults({
        running: false,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        steps: [],
      });
    } finally {
      setRunningRlnWalletChanPayFlow(false);
      rlnWalletChanPayInFlightRef.current = false;
    }
  }

  async function handleRlnUtexoPayFlow() {
    if (rlnUtexoPayInFlightRef.current) return;
    rlnUtexoPayInFlightRef.current = true;
    try {
      setRunningRlnUtexoPayFlow(true);
      setRlnUtexoPayResults({ running: true, steps: [] });
      const r = await runRLNUtexoPaymentFlow();
      setRlnUtexoPayResults({ ...r, running: false });
    } catch (e: any) {
      setRlnUtexoPayResults({
        running: false,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        steps: [],
      });
    } finally {
      setRunningRlnUtexoPayFlow(false);
      rlnUtexoPayInFlightRef.current = false;
    }
  }

  async function handleRlnAssetExtFlow() {
    if (rlnAssetExtInFlightRef.current) return;
    rlnAssetExtInFlightRef.current = true;
    try {
      setRunningRlnAssetExtFlow(true);
      setRlnAssetExtResults({ running: true, steps: [] });
      const r = await runRlnUtexoWalletAssetChannelExtSignerFlow();
      setRlnAssetExtResults({ ...r, running: false });
    } catch (e: any) {
      setRlnAssetExtResults({
        running: false,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        steps: [],
      });
    } finally {
      setRunningRlnAssetExtFlow(false);
      rlnAssetExtInFlightRef.current = false;
    }
  }

  async function handleRlnExtPayFlow() {
    if (rlnExtPayInFlightRef.current) return;
    rlnExtPayInFlightRef.current = true;
    try {
      setRunningRlnExtPayFlow(true);
      setRlnExtPayResults({ running: true, steps: [] });
      const r = await runRLNUtexoExternalPaymentFlow();
      setRlnExtPayResults({ ...r, running: false });
    } catch (e: any) {
      setRlnExtPayResults({
        running: false,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        steps: [],
      });
    } finally {
      setRunningRlnExtPayFlow(false);
      rlnExtPayInFlightRef.current = false;
    }
  }

  async function handleExtOsSendFlow() {
    if (extOsSendInFlightRef.current) return;
    extOsSendInFlightRef.current = true;
    try {
      setRunningExtOsSendFlow(true);
      setExtOsSendResults({ running: true, steps: [] });
      const r = await runExtSignerOnchainSendFlow();
      setExtOsSendResults({ ...r, running: false });
    } catch (e: any) {
      setExtOsSendResults({
        running: false,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        steps: [],
      });
    } finally {
      setRunningExtOsSendFlow(false);
      extOsSendInFlightRef.current = false;
    }
  }

  async function handleVssFlow() {
    if (vssFlowInFlightRef.current) return;
    vssFlowInFlightRef.current = true;
    try {
      setRunningVssFlow(true);
      setVssFlowResults({ running: true, steps: [] });
      const r = await runRlnUtexoVssFlow();
      setVssFlowResults({ ...r, running: false });
    } catch (e: any) {
      setVssFlowResults({
        running: false,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        steps: [],
      });
    } finally {
      setRunningVssFlow(false);
      vssFlowInFlightRef.current = false;
    }
  }

  async function handleRlnVssFlow() {
    if (rlnVssFlowInFlightRef.current) return;
    rlnVssFlowInFlightRef.current = true;
    try {
      setRunningRlnVssFlow(true);
      setRlnVssFlowResults({ running: true, steps: [] });
      const r = await runRlnVssFlow();
      setRlnVssFlowResults({ ...r, running: false });
    } catch (e: any) {
      setRlnVssFlowResults({
        running: false,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        steps: [],
      });
    } finally {
      setRunningRlnVssFlow(false);
      rlnVssFlowInFlightRef.current = false;
    }
  }

  async function handleMainnetInitFlow() {
    if (mainnetInitInFlightRef.current) return;
    mainnetInitInFlightRef.current = true;
    try {
      setRunningMainnetInitFlow(true);
      setMainnetInitResults({ running: true, steps: [] });
      const r = await runMainnetInitFlow();
      setMainnetInitResults({ ...r, running: false });
    } catch (e: any) {
      setMainnetInitResults({
        running: false,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        steps: [],
      });
    } finally {
      setRunningMainnetInitFlow(false);
      mainnetInitInFlightRef.current = false;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Flows</Text>
          <Text style={styles.headerSubtitle}>
            Run live SDK tests and end-to-end flow demos against real infrastructure.
          </Text>
          <View style={styles.networkRow}>
            <View style={styles.networkBadge}>
              <View style={styles.networkDot} />
              <Text style={styles.networkText}>
                {Platform.OS === 'android' ? 'Android · 10.0.2.2:8000' : 'iOS · 127.0.0.1:8000'}
              </Text>
            </View>
          </View>
          <View style={styles.envCard}>
            <Text style={styles.envTitle}>
              {activeTab === 'regtest' ? 'Regtest config' : activeTab === 'mainnet' ? 'Mainnet config' : 'UTEXO config'}
            </Text>
            {activeUnlockRows.map(([key, value]) => (
              <View key={key} style={styles.envRow}>
                <Text style={styles.envKey}>{key}</Text>
                <Text style={styles.envValue}>{value}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Network tab selector */}
        <View style={styles.tabRow}>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'regtest' && styles.tabBtnActive]}
            onPress={() => setActiveTab('regtest')}
            activeOpacity={0.75}>
            <Text style={[styles.tabBtnText, activeTab === 'regtest' && styles.tabBtnTextActive]}>
              Regtest
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'utexo' && styles.tabBtnActive]}
            onPress={() => setActiveTab('utexo')}
            activeOpacity={0.75}>
            <Text style={[styles.tabBtnText, activeTab === 'utexo' && styles.tabBtnTextActive]}>
              UTEXO
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tabBtn, activeTab === 'mainnet' && styles.tabBtnActive]}
            onPress={() => setActiveTab('mainnet')}
            activeOpacity={0.75}>
            <Text style={[styles.tabBtnText, activeTab === 'mainnet' && styles.tabBtnTextActive]}>
              Mainnet
            </Text>
          </TouchableOpacity>
        </View>

        {activeTab === 'regtest' && (
          <>
            <FlowCard
              title="BTC Channel · 2 Payments · Node Restart · RGB Sends"
              funcName="runRlnUtexoWalletChannelPaymentFlow"
              tags={['RGB Sends', 'Node Restart']}
              description="nodeA + nodeB (both PasswordRLNSigner). Opens 500k sat BTC channel. Payment 1 B→A, then nodeA shuts down and reinit()s. Payment 2 after restart. Then issues 1000 WCTS and sends 300 units (witness) + 200 units (blind) on-chain to nodeB. Final: A=500, B=500."
              accentColor="#1D3A8A"
              totalSteps={14}
              results={rlnWalletChanPayResults}
              running={runningRlnWalletChanPayFlow}
              onRun={handleRlnWalletChanPayFlow}>
              {rlnWalletChanPayResults?.steps?.map((step: any, idx: number, arr: any[]) => {
                const meta = RLN_DEMO_STEP_META[step.step] ?? { label: step.step, desc: '' };
                return (
                  <StepCard
                    key={idx}
                    idx={idx}
                    step={step}
                    label={meta.label}
                    desc={meta.desc}
                    accentColor="#1D3A8A"
                    isLast={idx === arr.length - 1}
                    deferErrorDisplay={runningRlnWalletChanPayFlow}
                  />
                );
              })}
            </FlowCard>

            <FlowCard
              title="RGB Asset Channel · 4 Payments · RGB Sends"
              funcName="runRLNUtexoPaymentFlow"
              tags={['RGB Sends']}
              description="3 nodes (all PasswordRLNSigner). nodeA issues 1000 USDT, opens asset channel to nodeB (600 units pushed). 4 LN payments alternating A↔B. Cooperative close. RGB on-chain: A→C 925 units, B→C 25 units. Final: A=25, B=25, C=950."
              accentColor="#1A5C38"
              totalSteps={26}
              results={rlnUtexoPayResults}
              running={runningRlnUtexoPayFlow}
              onRun={handleRlnUtexoPayFlow}>
              {rlnUtexoPayResults?.steps?.map((step: any, idx: number, arr: any[]) => {
                const meta = RLN_DEMO_STEP_META[step.step] ?? { label: step.step, desc: '' };
                return (
                  <StepCard
                    key={idx}
                    idx={idx}
                    step={step}
                    label={meta.label}
                    desc={meta.desc}
                    accentColor="#1A5C38"
                    isLast={idx === arr.length - 1}
                    deferErrorDisplay={runningRlnUtexoPayFlow}
                  />
                );
              })}
            </FlowCard>

            <FlowCard
              title="Ext Signer · Asset Channel · Restart · Reverse Channel · RGB Send"
              funcName="runRlnUtexoWalletAssetChannelExtSignerFlow"
              tags={['RGB Sends', 'Ext Signer', 'Node Restart', 'VLS Initiates Channel']}
              description="nodeA (Password) issues 1000 USDT, opens asset channel to nodeB (VLS ext signer). 2 LN payments — nodeA restarts between them. Cooperative close. Then nodeB (VLS) opens a REVERSE channel to nodeA — tests VLS as initiator. nodeB sends 150 units on-chain back to nodeA. Final: A=1000, B=0."
              accentColor="#7B2D8A"
              totalSteps={19}
              results={rlnAssetExtResults}
              running={runningRlnAssetExtFlow}
              onRun={handleRlnAssetExtFlow}>
              {rlnAssetExtResults?.steps?.map((step: any, idx: number, arr: any[]) => {
                const meta = RLN_DEMO_STEP_META[step.step] ?? { label: step.step, desc: '' };
                return (
                  <StepCard
                    key={idx}
                    idx={idx}
                    step={step}
                    label={meta.label}
                    desc={meta.desc}
                    accentColor="#7B2D8A"
                    isLast={idx === arr.length - 1}
                    deferErrorDisplay={runningRlnAssetExtFlow}
                  />
                );
              })}
            </FlowCard>

            <FlowCard
              title="Ext Signer NodeB · RGB Asset Channel · 4 Payments"
              funcName="runRLNUtexoExternalPaymentFlow"
              tags={['Ext Signer']}
              description="Mirror of the 3-node payment flow but nodeB uses NativeExternalRLNSigner (VLS). pushMsat=0 required — VLS rejects non-zero push as acceptor. 4 LN payments alternating A↔B, cooperative close. RGB on-chain sends to nodeC are TODO. Final: A=950, B=50."
              accentColor="#8A3D1D"
              totalSteps={26}
              results={rlnExtPayResults}
              running={runningRlnExtPayFlow}
              onRun={handleRlnExtPayFlow}>
              {rlnExtPayResults?.steps?.map((step: any, idx: number, arr: any[]) => {
                const meta = RLN_DEMO_STEP_META[step.step] ?? { label: step.step, desc: '' };
                return (
                  <StepCard
                    key={idx}
                    idx={idx}
                    step={step}
                    label={meta.label}
                    desc={meta.desc}
                    accentColor="#8A3D1D"
                    isLast={idx === arr.length - 1}
                    deferErrorDisplay={runningRlnExtPayFlow}
                  />
                );
              })}
            </FlowCard>

            <FlowCard
              title="Ext Signer · RGB On-chain Send (no channel)"
              funcName="runExtSignerOnchainSendFlow"
              tags={['RGB Send', 'Ext Signer', 'On-chain']}
              description="nodeB (Password) issues 1000 XSND, sends 500 on-chain to nodeA (NativeExternalRLNSigner) via blindReceive. nodeA then sends 250 back — exercises rgb_send_begin → rgb_sign_psbt → rgb_send_end on the ext signer path. Final: A=250, B=750."
              accentColor="#1D5C8A"
              totalSteps={13}
              results={extOsSendResults}
              running={runningExtOsSendFlow}
              onRun={handleExtOsSendFlow}>
              {extOsSendResults?.steps?.map((step: any, idx: number, arr: any[]) => {
                const meta = RLN_DEMO_STEP_META[step.step] ?? { label: step.step, desc: '' };
                return (
                  <StepCard
                    key={idx}
                    idx={idx}
                    step={step}
                    label={meta.label}
                    desc={meta.desc}
                    accentColor="#1D5C8A"
                    isLast={idx === arr.length - 1}
                    deferErrorDisplay={runningExtOsSendFlow}
                  />
                );
              })}
            </FlowCard>

            <FlowCard
              title="VSS Backup & Restore"
              funcName="runRlnVssFlow"
              tags={['VSS', 'Regtest']}
              description="Init UTEXOWallet with VSS on regtest. Fund 1,227,500 sats, create 3 × 32,500-sat UTXOs, issue 500 VDMO. Open BTC channel. Shut down and wipe local state. Restore from VSS — verifies pubkey match, channel presence, and asset balance after restore."
              accentColor="#6B3D1D"
              totalSteps={11}
              results={rlnVssFlowResults}
              running={runningRlnVssFlow}
              onRun={handleRlnVssFlow}>
              {rlnVssFlowResults?.steps?.map((step: any, idx: number, arr: any[]) => {
                const meta = RLN_VSS_STEP_META[step.step] ?? { label: step.step, desc: '' };
                return (
                  <StepCard
                    key={idx}
                    idx={idx}
                    step={step}
                    label={meta.label}
                    desc={meta.desc}
                    accentColor="#6B3D1D"
                    isLast={idx === arr.length - 1}
                    deferErrorDisplay={runningRlnVssFlow}
                  />
                );
              })}
            </FlowCard>



            <VirtualChannelScreen embedded />

            <VirtualChannelBtcScreen embedded />
          </>
        )}

        {activeTab === 'utexo' && (
          <>
          <FlowCard
            title={process.env.EXPO_PUBLIC_UTEXO_VSS_BACKUP_ONLY === '1' ? 'VSS Init & Backup' : 'VSS Backup & Restore'}
            funcName="runRlnUtexoVssFlow"
            tags={['VSS', 'UTEXO Testnet']}
            description={process.env.EXPO_PUBLIC_UTEXO_VSS_BACKUP_ONLY === '1'
              ? 'Temporary diagnostic: init and unlock a fresh UTEXO wallet, then immediately call backupNow using the configured UTEXO VSS endpoint.'
              : 'Fund a UTEXO wallet, issue 500 VDMO and open a BTC channel. Back up, wipe and restore; verify pubkey, channel and RGB balance.'}
            accentColor="#1D6B8A"
            totalSteps={process.env.EXPO_PUBLIC_UTEXO_VSS_BACKUP_ONLY === '1' ? 2 : 13}
            results={vssFlowResults}
            running={runningVssFlow}
            onRun={handleVssFlow}>
            {vssFlowResults?.steps?.map((step: any, idx: number, arr: any[]) => {
              const meta = UTEXO_VSS_STEP_META[step.step] ?? { label: step.step, desc: '' };
              return (
                <StepCard
                  key={idx}
                  idx={idx}
                  step={step}
                  label={meta.label}
                  desc={meta.desc}
                  accentColor="#1D6B8A"
                  isLast={idx === arr.length - 1}
                  deferErrorDisplay={runningVssFlow}
                />
              );
            })}
          </FlowCard>
          <VirtualChannelSignetScreen embedded />
          </>
        )}

        {activeTab === 'mainnet' && (
          <>
          <FlowCard
            title="Mainnet · Init, Unlock, Get Address"
            funcName="runMainnetInitFlow"
            tags={['Mainnet', 'Read-only']}
            description="Creates a single UTEXOWallet node (PasswordRLNSigner) against real Bitcoin mainnet, unlocks it with the mainnet indexer/proxy endpoints, and derives a receive address. No funding, UTXOs, or channels — nothing is ever spent."
            accentColor="#8A1D2E"
            totalSteps={3}
            results={mainnetInitResults}
            running={runningMainnetInitFlow}
            onRun={handleMainnetInitFlow}>
            {mainnetInitResults?.steps?.map((step: any, idx: number, arr: any[]) => {
              const meta = RLN_DEMO_STEP_META[step.step] ?? { label: step.step, desc: '' };
              return (
                <StepCard
                  key={idx}
                  idx={idx}
                  step={step}
                  label={meta.label}
                  desc={meta.desc}
                  accentColor="#8A1D2E"
                  isLast={idx === arr.length - 1}
                  deferErrorDisplay={runningMainnetInitFlow}
                />
              );
            })}
          </FlowCard>
          </>
        )}

        <View style={styles.footer} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', web: 'monospace' });

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: AppColors.bgBase },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 40 },

  header: { paddingTop: 24, paddingBottom: 16, gap: 8 },
  headerTitle: { fontSize: 26, fontWeight: '800', color: AppColors.textPrimary, letterSpacing: 0.5 },
  headerSubtitle: { fontSize: 14, color: AppColors.textSecondary, lineHeight: 20 },
  rlnOnlyBanner: {
    marginTop: 4,
    backgroundColor: '#1E3A8A1F',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3B82F680',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  rlnOnlyBannerText: {
    fontSize: 12,
    color: '#BFDBFE',
    lineHeight: 16,
    fontWeight: '600',
  },
  networkRow: { flexDirection: 'row', marginTop: 4 },
  networkBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: AppColors.bgCard,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: AppColors.border,
  },
  networkDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: AppColors.success },
  networkText: { fontSize: 12, color: AppColors.textSecondary, fontFamily: MONO },
  envCard: {
    marginTop: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: AppColors.border,
    backgroundColor: AppColors.bgCard,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  envTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: AppColors.textSecondary,
  },
  envRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  envKey: {
    flex: 1,
    fontSize: 11,
    color: AppColors.textTertiary,
    fontFamily: MONO,
  },
  envValue: {
    flex: 1,
    fontSize: 11,
    color: AppColors.textSecondary,
    textAlign: 'right',
    fontFamily: MONO,
  },

  tabRow: {
    flexDirection: 'row',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: AppColors.border,
    overflow: 'hidden',
    marginBottom: 16,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: AppColors.bgBase,
  },
  tabBtnActive: {
    backgroundColor: AppColors.primary,
  },
  tabBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: AppColors.textSecondary,
  },
  tabBtnTextActive: {
    color: AppColors.black,
  },

  storeIdRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: AppColors.border,
  },
  storeIdLabel: { fontSize: 11, fontWeight: '700', color: AppColors.textTertiary },
  storeIdValue: { flex: 1, fontSize: 11, color: AppColors.textSecondary, fontFamily: MONO },

  footer: { height: 20 },
});

// Step card styles — timeline layout
const sStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: 14,
  },

  // Left: circle + vertical line
  timelineCol: {
    width: 32,
    alignItems: 'center',
  },
  circle: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  circleText: {
    fontSize: 10,
    fontWeight: '700',
    includeFontPadding: false,
  },
  line: {
    width: 1.5,
    flex: 1,
    marginVertical: 3,
  },

  // Right: content
  stepContent: {
    flex: 1,
    paddingLeft: 12,
    paddingTop: 2,
    paddingBottom: 4,
    gap: 3,
  },
  stepContentSpaced: {
    paddingBottom: 18,
  },
  stepTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flexWrap: 'wrap',
  },
  stepLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: AppColors.textSecondary,
  },
  statusTag: {
    borderRadius: 5,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  statusTagText: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  stepDesc: {
    fontSize: 12,
    color: AppColors.textTertiary,
    lineHeight: 17,
  },
  codeBox: {
    marginTop: 5,
    backgroundColor: AppColors.bgBase,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: AppColors.border,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  codeText: {
    fontFamily: MONO,
    fontSize: 11,
    color: AppColors.textSecondary,
    lineHeight: 17,
  },
});

// Flow card styles
const fStyles = StyleSheet.create({
  card: {
    backgroundColor: AppColors.bgCard,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 14,
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  cardAccentBar: { width: 3, borderRadius: 2, marginRight: 12 },
  cardTitleArea: { flex: 1, gap: 4 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  cardTitle: { fontSize: 16, fontWeight: '700', color: AppColors.textPrimary },
  funcName: { fontSize: 11, color: AppColors.textTertiary, fontFamily: MONO, marginTop: 2 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 5 },
  tag: { borderRadius: 5, borderWidth: 1, borderColor: AppColors.border, backgroundColor: AppColors.bgCardElevated, paddingHorizontal: 7, paddingVertical: 2 },
  tagText: { fontSize: 10, fontWeight: '600', color: AppColors.textTertiary },
  tagRgb: { borderColor: '#1A5C3880', backgroundColor: '#1A5C3820' },
  tagTextRgb: { color: '#4ADE80' },
  statusPill: {
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
  },
  statusText: { fontSize: 11, fontWeight: '600' },
  cardDesc: { fontSize: 13, color: AppColors.textSecondary, lineHeight: 18 },
  flowErrorBox: {
    marginHorizontal: 14,
    marginTop: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: AppColors.errorBorder,
    backgroundColor: AppColors.errorBg,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 4,
  },
  flowErrorTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: AppColors.error,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  flowErrorText: {
    fontSize: 11,
    lineHeight: 16,
    color: '#FCA5A5',
    fontFamily: MONO,
  },

  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexWrap: 'wrap',
  },
  dot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progressLabel: { fontSize: 11, color: AppColors.textTertiary, marginLeft: 4, fontFamily: MONO },

  idleBody: { padding: 14 },
  runBtn: {
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  runBtnText: { color: '#fff', fontWeight: '700', fontSize: 14, letterSpacing: 0.3 },

  stepsWrapper: {
    paddingTop: 12,
    paddingBottom: 4,
  },

  rerunBtn: {
    borderTopWidth: 1,
    borderColor: AppColors.border,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  rerunBtnText: { fontWeight: '700', fontSize: 13 },
});
