import { useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';


import { AppColors } from '@/constants/theme';

// ─── Data ────────────────────────────────────────────────────────────────────

type Item = {
  name: string;
  sig: string;   // compact TypeScript signature: "(params) → ReturnType"
  desc: string;
};

type Section = {
  title: string;
  items: Item[];
};

const SDK_SECTIONS: Section[] = [
  {
    title: 'Standalone Functions',
    items: [
      { name: 'createWallet()',              sig: '(network: Network) → Promise<WalletKeys>',                    desc: 'Generate fresh keypair + return all derived keys' },
      { name: 'generateKeys()',              sig: '(network: Network) → Promise<WalletKeys>',                    desc: 'Same as createWallet — alias used in flows' },
      { name: 'deriveKeysFromMnemonic()',    sig: '(network, mnemonic: string) → Promise<WalletKeys>',           desc: 'Derive keys from BIP-39 mnemonic deterministically' },
      { name: 'signMessage()',               sig: '({ message, seed, network }) → Promise<string>',              desc: 'Sign an arbitrary message with wallet keys' },
      { name: 'verifyMessage()',             sig: '({ message, signature, accountXpub, network }) → Promise<boolean>', desc: 'Verify a message signature' },
      { name: 'toUnitsNumber()',             sig: '(amount: number, precision: number) → number',                desc: 'Convert decimal amount to base units' },
      { name: 'fromUnitsNumber()',           sig: '(amount: number, precision: number) → number',                desc: 'Convert base units to decimal display amount' },
    ],
  },
  {
    title: 'UTEXOWallet',
    items: [
      { name: 'new UTEXOWallet()',           sig: '(config: WalletConfig, signer: RLNSigner) → UTEXOWallet',    desc: 'Instantiate a wallet node. Does not connect — call init() next.' },
      { name: 'init()',                      sig: '() → Promise<void>',                                         desc: 'Create the RLN node and run the signer setup (createNode + signer.initNode)' },
      { name: 'unlock()',                    sig: '(params: UnlockParams) → Promise<void>',                     desc: 'Connect to bitcoind + indexer + proxy and bring the node online' },
      { name: 'reinit()',                    sig: '(params: UnlockParams) → Promise<void>',                     desc: 'Shutdown + unlock in one call — restart without recreating the instance' },
      { name: 'shutdown()',                  sig: '() → Promise<void>',                                         desc: 'Stop the RLN daemon, keeping the instance alive for reinit()' },
      { name: 'destroy()',                   sig: '() → Promise<void>',                                         desc: 'Shutdown + release all resources. Call in finally blocks.' },
      { name: 'getNodeInfo()',               sig: '() → Promise<RlnNodeInfo>',                                  desc: 'pubkey, numChannels, numUsableChannels, localBalanceMsat, peers[]' },
      { name: 'getNetworkInfo()',            sig: '() → Promise<{ network: string; height: number }>',          desc: 'Current chain and best block height' },
      { name: 'getAddress()',                sig: '() → Promise<string>',                                       desc: 'Derive a fresh bech32 receive address' },
      { name: 'getBtcBalance()',             sig: '() → Promise<BtcBalance>',                                   desc: 'vanilla + colored: { spendable, future, immature }' },
      { name: 'getAssetBalance()',           sig: '(assetId: string) → Promise<AssetBalance>',                  desc: 'spendable, future, settled, offchainInbound, offchainOutbound' },
      { name: 'syncWallet()',                sig: '() → Promise<void>',                                         desc: 'Sync wallet UTXO set with the indexer' },
      { name: 'refreshWallet()',             sig: '() → Promise<void>',                                         desc: 'Refresh RGB transfer statuses from the proxy' },
      { name: 'createUtxos()',               sig: '({ upTo, num, feeRate, size? }) → Promise<void>',            desc: 'Allocate UTXOs for RGB operations. Mine 1 block after on regtest.' },
      { name: 'listUnspents()',              sig: '() → Promise<Unspent[]>',                                    desc: 'All UTXOs with their RGB allocations' },
      { name: 'listAssets()',                sig: '() → Promise<{ nia?: AssetNIA[]; cfa?: AssetCFA[] }>',       desc: 'All RGB assets tracked by this wallet' },
      { name: 'listTransactions()',          sig: '() → Promise<Transaction[]>',                                desc: 'All on-chain transactions' },
      { name: 'listTransfers()',             sig: '(assetId: string) → Promise<Transfer[]>',                    desc: 'RGB transfers for a specific asset. Transfer has expiration field.' },
      { name: 'listOnchainTransfers()',      sig: '(assetId: string) → Promise<Transfer[]>',                    desc: 'On-chain RGB transfers only (Send / Receive)' },
      { name: 'failTransfers()',             sig: '({ batchTransferIdx?, noAssetOnly }) → Promise<boolean>',    desc: 'Mark stale/expired pending transfers as failed. Returns true if any changed.' },
      { name: 'issueAssetNia()',             sig: '({ ticker, name, precision, amounts }) → Promise<AssetNIA>', desc: 'Issue a Non-Inflatable RGB asset. Mine 1 block after on regtest.' },
      { name: 'blindReceive()',              sig: '({ minConfirmations, durationSeconds? }) → Promise<InvoiceReceiveData>', desc: 'Generate a blinded receive invoice. Returns invoice, recipientId, batchTransferIdx.' },
      { name: 'witnessReceive()',            sig: '({ minConfirmations }) → Promise<InvoiceReceiveData>',       desc: 'Generate a witness receive invoice (UTXO-anchored)' },
      { name: 'send()',                      sig: '({ invoice, assetId, amount, donation, feeRate, minConfirmations, witnessData? }) → Promise<SendResult>', desc: 'On-chain RGB transfer. SendResult has txid + batchTransferIdx.' },
      { name: 'onchainSend()',               sig: '({ invoice, amount, feeRate, minConfirmations, skipSync }) → Promise<void>', desc: 'Send RGB via on-chain transport (used in LSP flow for Node B → LSP)' },
      { name: 'estimateFeeRate()',           sig: '(blocks: number) → Promise<number>',                         desc: 'Estimate sat/vB fee rate for confirmation in N blocks' },
      { name: 'connectPeer()',               sig: '(peerUri: string) → Promise<void>',                         desc: 'Connect to a peer. Format: pubkey@host:port. Errors are usually safe to ignore.' },
      { name: 'listPeers()',                 sig: '() → Promise<Peer[]>',                                       desc: 'List currently connected peers' },
      { name: 'listChannels()',              sig: '() → Promise<RlnChannel[]>',                                 desc: 'All channels: channelId, fundingTxid, isUsable, capacitySat, assetId?, assetLocalAmount?' },
      { name: 'openChannel()',               sig: '({ peerPubkey, capacitySat, pushMsat, public, withAnchors, assetId?, assetAmount? }) → Promise<{ temporaryChannelId }>',  desc: 'Open a BTC or RGB asset channel. Poll listChannels() for fundingTxid, then mine 6 blocks.' },
      { name: 'closeChannel()',              sig: '(channelId: string, peerPubkey: string, force: boolean) → Promise<void>', desc: 'Cooperative (force=false) or force close. Mine + refreshWallet ×3 after.' },
      { name: 'createLightningInvoice()',    sig: '({ amountSats, expirySeconds, asset: { assetId, amount } }) → Promise<{ lnInvoice }>',  desc: 'Create a BOLT11 invoice for an RGB asset payment' },
      { name: 'payLightningInvoice()',       sig: '({ lnInvoice: string }) → Promise<{ txid }>',               desc: 'Pay a BOLT11 invoice. Poll getLightningSendStatus() with the returned txid.' },
      { name: 'getLightningSendStatus()',   sig: '(paymentHash: string) → Promise<"Pending" | "Settled" | "Failed">', desc: 'Poll payment status after payLightningInvoice()' },
      { name: 'getLightningReceiveRequest()', sig: '(lnInvoice: string) → Promise<"Pending" | "Settled" | "Failed">', desc: 'Poll invoice status after createLightningInvoice()' },
      { name: 'listLightningPayments()',     sig: '() → Promise<{ payments: LightningPayment[] }>',            desc: 'All lightning payment history' },
      { name: 'vssClearFence()',             sig: '(password: string) → Promise<void>',                        desc: 'Clear the VSS fence before restore — call after init() and before unlock()' },
    ],
  },
  {
    title: 'Signers',
    items: [
      { name: 'PasswordRLNSigner',           sig: '(password: string, mnemonic: string) → PasswordRLNSigner', desc: 'Standard signer. Injects password automatically on unlock.' },
      { name: 'NativeExternalRLNSigner',     sig: '(mnemonic: string, network: Network) → NativeExternalRLNSigner', desc: 'VLS-backed external signer. Use when testing the external signer path. pushMsat must be 0 on acceptor side.' },
    ],
  },
  {
    title: 'UtexoLSPClient',
    items: [
      { name: 'new UtexoLSPClient()',        sig: '({ baseUrl: string }) → UtexoLSPClient',                    desc: 'HTTP client for the utexo-lsp Go service' },
      { name: 'getInfo()',                   sig: '() → Promise<LspInfo>',                                     desc: 'pubkey, num_channels, num_usable_channels, local_balance_sat' },
      { name: 'lightningReceive()',          sig: '({ lnInvoice, rgb: { assetId, durationSeconds? } }) → Promise<{ lnInvoice, rgbInvoice, mappingId }>',  desc: 'Register an LN invoice with the LSP. Returns an RGB invoice for the faucet/sender to pay.' },
    ],
  },
  {
    title: 'Error Classes',
    items: [
      { name: 'SDKError',             sig: '(message, code) → SDKError',              desc: 'Base class — all SDK errors extend this' },
      { name: 'NetworkError',         sig: '(message, statusCode: number)',            desc: 'HTTP/network failures. Check .statusCode.' },
      { name: 'ValidationError',      sig: '(message, field: string)',                 desc: 'Input validation failures. Check .field.' },
      { name: 'WalletError',          sig: '(message)',                                desc: 'Wallet state and operation errors' },
      { name: 'CryptoError',          sig: '(message)',                                desc: 'Cryptographic operation errors' },
      { name: 'ConfigurationError',   sig: '(message)',                                desc: 'Invalid SDK configuration' },
      { name: 'BadRequestError',      sig: '(message) · statusCode=400',              desc: 'HTTP 400 — bad request' },
      { name: 'NotFoundError',        sig: '(message) · statusCode=404',              desc: 'HTTP 404 — resource not found' },
      { name: 'ConflictError',        sig: '(message) · statusCode=409',              desc: 'HTTP 409 — conflict (e.g. estimateFeeRate right after unlock)' },
      { name: 'RgbNodeError',         sig: '(message, code)',                          desc: 'RGB node operation errors. code="InsufficientAssets" etc.' },
    ],
  },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function VersionBadge({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={styles.badge}>
      <View style={styles.badgeLabel}>
        <Text style={styles.badgeLabelText}>{label}</Text>
      </View>
      <View style={[styles.badgeValue, accent && styles.badgeValueAccent]}>
        <Text style={styles.badgeValueText} numberOfLines={1}>{value}</Text>
      </View>
    </View>
  );
}

function SectionCard({ title, items }: { title: string; items: Item[] }) {
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.section}>
      <TouchableOpacity
        style={styles.sectionHeader}
        onPress={() => setOpen(v => !v)}
        activeOpacity={0.75}>
        <View style={styles.sectionHeaderLeft}>
          <View style={styles.sectionAccent} />
          <Text style={styles.sectionTitle}>{title}</Text>
        </View>
        <View style={styles.sectionHeaderRight}>
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{items.length}</Text>
          </View>
          <Text style={[styles.chevron, open && styles.chevronOpen]}>›</Text>
        </View>
      </TouchableOpacity>

      {open && (
        <View style={styles.sectionBody}>
          {items.map((item, idx) => (
            <View key={item.name} style={[styles.methodRow, idx < items.length - 1 && styles.methodRowBorder]}>
              <View style={styles.methodDot} />
              <View style={styles.methodInfo}>
                <Text style={styles.methodName}>{item.name}</Text>
                <Text style={styles.methodSig}>{item.sig}</Text>
                <Text style={styles.methodDesc}>{item.desc}</Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function DocsScreen() {
  const totalMethods = SDK_SECTIONS.reduce((sum, s) => sum + s.items.length, 0);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <Text style={styles.logoText}>UTEXO</Text>
            <View style={styles.headerBadge}>
              <Text style={styles.headerBadgeText}>SDK Reference</Text>
            </View>
          </View>
          <Text style={styles.headerSubtitle}>
            API reference for the methods used in this demo.
          </Text>

          {/* Version badges */}
          <View style={styles.badgeRow}>
            <VersionBadge
              label="package"
              value="@utexo/rgb-sdk-rn@1.0.0-beta.37"
              accent
            />
            {Platform.OS === 'android' && (
              <VersionBadge
                label="rgb-lib"
                value="android@0.3.0-beta.14"
              />
            )}
          </View>

          {/* Stats bar */}
          <View style={styles.statsBar}>
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{SDK_SECTIONS.length}</Text>
              <Text style={styles.statLabel}>sections</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{totalMethods}</Text>
              <Text style={styles.statLabel}>methods</Text>
            </View>
          </View>
        </View>

        {/* Hint */}
        <Text style={styles.hint}>Tap a section to expand its API</Text>

        {/* Sections */}
        {SDK_SECTIONS.map(section => (
          <SectionCard key={section.title} title={section.title} items={section.items} />
        ))}

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            See the Flows tab to run live end-to-end demos against real infrastructure.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', web: 'monospace' });

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: AppColors.bgBase,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },

  // Header
  header: {
    paddingTop: 24,
    paddingBottom: 20,
    gap: 12,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  logoText: {
    fontSize: 26,
    fontWeight: '800',
    color: AppColors.textPrimary,
    letterSpacing: 2,
  },
  headerBadge: {
    backgroundColor: AppColors.primaryBg,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: AppColors.borderAccent,
  },
  headerBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: AppColors.primary,
    letterSpacing: 0.5,
  },
  headerSubtitle: {
    fontSize: 14,
    color: AppColors.textSecondary,
    lineHeight: 20,
  },

  // Version badges
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  badge: {
    flexDirection: 'row',
    borderRadius: 6,
    overflow: 'hidden',
  },
  badgeLabel: {
    backgroundColor: '#374151',
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  badgeLabelText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#D1D5DB',
    fontFamily: MONO,
  },
  badgeValue: {
    backgroundColor: '#1E3A5F',
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  badgeValueAccent: {
    backgroundColor: AppColors.primaryBg,
  },
  badgeValueText: {
    fontSize: 11,
    fontWeight: '600',
    color: AppColors.primary,
    fontFamily: MONO,
  },

  // Stats bar
  statsBar: {
    flexDirection: 'row',
    backgroundColor: AppColors.bgCard,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: AppColors.border,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  statItem: {
    alignItems: 'center',
    gap: 2,
  },
  statValue: {
    fontSize: 20,
    fontWeight: '700',
    color: AppColors.textAccent,
  },
  statLabel: {
    fontSize: 11,
    color: AppColors.textTertiary,
    letterSpacing: 0.3,
  },
  statDivider: {
    width: 1,
    height: 28,
    backgroundColor: AppColors.border,
  },

  // Hint
  hint: {
    fontSize: 12,
    color: AppColors.textTertiary,
    marginBottom: 10,
    letterSpacing: 0.2,
  },

  // Section card
  section: {
    backgroundColor: AppColors.bgCard,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: AppColors.border,
    marginBottom: 10,
    overflow: 'hidden',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  sectionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  sectionAccent: {
    width: 3,
    height: 18,
    borderRadius: 2,
    backgroundColor: AppColors.primary,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: AppColors.textPrimary,
    letterSpacing: 0.1,
  },
  sectionHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  countBadge: {
    backgroundColor: AppColors.primaryBg,
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
    minWidth: 24,
    alignItems: 'center',
  },
  countText: {
    fontSize: 11,
    fontWeight: '700',
    color: AppColors.primary,
  },
  chevron: {
    fontSize: 20,
    color: AppColors.textTertiary,
    transform: [{ rotate: '0deg' }],
    lineHeight: 22,
  },
  chevronOpen: {
    transform: [{ rotate: '90deg' }],
    color: AppColors.primary,
  },

  // Section body
  sectionBody: {
    borderTopWidth: 1,
    borderTopColor: AppColors.borderSubtle,
  },
  methodRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
  },
  methodRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: AppColors.borderSubtle,
  },
  methodDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: AppColors.primary,
    marginTop: 7,
  },
  methodInfo: {
    flex: 1,
    gap: 2,
  },
  methodName: {
    fontSize: 13,
    fontWeight: '700',
    color: AppColors.textPrimary,
    fontFamily: MONO,
  },
  methodSig: {
    fontSize: 11,
    color: AppColors.textTertiary,
    fontFamily: MONO,
    lineHeight: 16,
  },
  methodDesc: {
    fontSize: 12,
    color: AppColors.textSecondary,
    lineHeight: 17,
    marginTop: 1,
  },

  // Footer
  footer: {
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: AppColors.border,
  },
  footerText: {
    fontSize: 13,
    color: AppColors.textTertiary,
    textAlign: 'center',
    lineHeight: 19,
  },
});
