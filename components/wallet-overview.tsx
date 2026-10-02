import { useEffect, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppColors as C } from '@/constants/theme';
import { demoWallet, type DemoWalletState } from '@/utils/wallet';
import { mockFaucetEnabled } from '@/utils/mock-faucet';

type Tab = 'Assets' | 'Receive' | 'Activity' | 'Tools';

export function WalletButton({ title, onPress, disabled = false }: {
  title: string; onPress: () => void; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress} style={[styles.button, disabled && styles.disabled]}>
    <Text style={styles.buttonText}>{title}</Text>
  </Pressable>;
}

function BalanceRows({ balance, unit }: {
  balance: { spendable: number; settled: number; future: number }; unit: string;
}) {
  return <View style={styles.group}>
    {([['Available', balance.spendable], ['Confirmed', balance.settled], ['After pending transfers', balance.future]] as const).map(([label, value]) =>
      <View key={label} style={styles.row}>
        <Text style={styles.text}>{label}</Text>
        <Text selectable style={styles.value}>{value} {unit}</Text>
      </View>)}
  </View>;
}

export function WalletOverview({ state }: { state: DemoWalletState }) {
  const [tab, setTab] = useState<Tab>('Assets');
  const [amount, setAmount] = useState('');
  const [assetId, setAssetId] = useState('');
  const [durationMinutes, setDurationMinutes] = useState('60');
  const [feedback, setFeedback] = useState('');
  const [now, setNow] = useState(Date.now());
  const disabled = state.busy || !!state.prompt || !!state.activeRequest;
  const invoice = state.invoice;
  const selectedBfa = state.assets.find((asset) => asset.assetId === assetId)?.schema === 'BFA';
  const expired = !!invoice?.expirationTimestamp && invoice.expirationTimestamp * 1000 <= now;

  useEffect(() => {
    if (tab !== 'Receive' || !invoice?.expirationTimestamp) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [tab, invoice?.expirationTimestamp]);

  const copy = async (value: string, label: string) => {
    try {
      // Load on demand so an older native build can still open the wallet.
      const Clipboard = await import('expo-clipboard');
      if (!(await Clipboard.setStringAsync(value))) throw new Error('Clipboard is unavailable');
      setFeedback(`${label} copied.`);
    } catch {
      setFeedback('Could not copy. Long-press the text to copy it; rebuild the app if Clipboard is unavailable.');
    }
  };

  return <View style={styles.card}>
    <View style={styles.tabs}>
      {(['Assets', 'Receive', 'Activity', 'Tools'] as const).map((value) =>
        <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: tab === value }}
          style={[styles.tab, tab === value && styles.selectedTab]} onPress={() => { setTab(value); setFeedback(''); }}>
          <Text style={[styles.text, tab === value && styles.selectedText]}>{value}</Text>
        </Pressable>)}
    </View>

    {tab === 'Assets' && <>
      <Text style={styles.heading}>RGB assets · {state.assets.length}</Text>
      {!state.assets.length && <Text style={styles.text}>
        {state.updatedAt ? 'No RGB assets yet. Create an invoice in Receive to get your first asset.' : 'Refresh to load assets.'}
      </Text>}
      {state.assets.map((asset) => <View key={asset.assetId} style={styles.item}>
        <View style={styles.row}>
          <Text style={styles.assetName}>{asset.ticker || asset.name}</Text>
          <Text style={styles.badge}>{asset.schema}</Text>
        </View>
        <Text style={styles.text}>{asset.name} · precision {asset.precision}</Text>
        <BalanceRows balance={asset.balance} unit="units" />
        <Text style={styles.hint}>Balances are in base units.</Text>
        <Text selectable style={styles.mono}>{asset.assetId}</Text>
        <WalletButton title={`Receive ${asset.ticker || asset.name}`} disabled={disabled}
          onPress={() => { setAssetId(asset.assetId); if (asset.schema === 'BFA') setAmount(''); setTab('Receive'); setFeedback(''); }} />
      </View>)}
      <Text style={styles.heading}>Bitcoin</Text>
      {state.btcBalance ? <>
        <Text style={styles.label}>BTC wallet</Text>
        <BalanceRows balance={state.btcBalance.vanilla} unit="sats" />
        <Text style={styles.label}>BTC in RGB UTXOs</Text>
        <BalanceRows balance={state.btcBalance.colored} unit="sats" />
      </> : <Text style={styles.text}>Balance not loaded. Tap Refresh wallet.</Text>}
    </>}

    {tab === 'Receive' && <>
      <Text style={styles.heading}>Receive RGB</Text>
      <Text style={styles.text}>Create an invoice here without connecting a website. Choose Any / new asset for your first receipt.</Text>
      <Text style={styles.label}>Asset</Text>
      <View style={styles.group}>
        {[{ assetId: '', name: 'Any / new asset' }, ...state.assets.map((asset) => ({ assetId: asset.assetId, name: asset.ticker || asset.name }))].map((asset) =>
          <Pressable key={asset.assetId} accessibilityRole="radio" accessibilityState={{ checked: assetId === asset.assetId, disabled }}
            disabled={disabled} onPress={() => {
              setAssetId(asset.assetId);
              if (state.assets.find((item) => item.assetId === asset.assetId)?.schema === 'BFA') setAmount('');
            }} style={[styles.choice, assetId === asset.assetId && styles.selectedTab]}>
            <Text style={styles.text}>{assetId === asset.assetId ? '●' : '○'} {asset.name}</Text>
          </Pressable>)}
      </View>
      <Text style={styles.label}>Amount in base units (optional)</Text>
      <TextInput accessibilityLabel="Receive amount in base units" value={amount} onChangeText={setAmount}
        placeholder="Any amount" placeholderTextColor={C.textTertiary} keyboardType="number-pad"
        editable={!disabled && !selectedBfa} style={[styles.input, selectedBfa && styles.disabled]} />
      {selectedBfa && <Text style={styles.text}>
        This BFA currently supports invoices with an open amount. To request a fixed amount, choose Any / new asset.
      </Text>}
      <Text style={styles.label}>Invoice expiry in minutes</Text>
      <TextInput accessibilityLabel="Invoice expiry in minutes" value={durationMinutes} onChangeText={setDurationMinutes}
        keyboardType="number-pad" editable={!disabled} style={styles.input} />
      <Text style={styles.hint}>3 confirmations required. Prepare receive UTXOs in Tools if needed.</Text>
      <WalletButton title="Generate invoice" disabled={disabled}
        onPress={() => { setFeedback(''); void demoWallet.generateInvoice({ amount, assetId, durationMinutes }); }} />
      {invoice && <View style={styles.item}>
        <Text style={styles.heading}>{expired ? 'Last invoice · expired' : 'Last receive invoice'}</Text>
        <Text style={styles.text}>{invoice.source}</Text>
        <Text style={styles.text}>{invoice.amount === undefined ? 'Any amount' : `${invoice.amount} base units`}</Text>
        <Text selectable style={styles.hint}>{invoice.assetId || 'Any / new asset'}</Text>
        {!!invoice.expirationTimestamp && <Text style={[styles.text, expired && styles.error]}>
          {expired ? 'Expired' : 'Expires'} {new Date(invoice.expirationTimestamp * 1000).toLocaleString()}
        </Text>}
        <Text selectable style={styles.mono}>{invoice.invoice}</Text>
        <WalletButton title="Copy invoice" disabled={expired}
          onPress={() => { void copy(invoice.invoice, 'Invoice'); }} />
        <WalletButton title="Share invoice" disabled={expired} onPress={() => {
          void Share.share({ message: invoice.invoice }).catch(() => setFeedback('Could not open sharing. Long-press the invoice to copy it.'));
        }} />
      </View>}
      <View style={styles.item}>
        <Text style={styles.heading}>Receive BTC</Text>
        <Text selectable style={styles.mono}>{state.address}</Text>
        <WalletButton title="Copy BTC address" onPress={() => { void copy(state.address, 'BTC address'); }} />
      </View>
    </>}

    {tab === 'Activity' && <>
      <Text style={styles.heading}>Recent RGB transfers</Text>
      {!state.transfers.length && <Text style={styles.text}>
        {state.updatedAt ? 'No transfers yet.' : 'Refresh to load transfer history.'}
      </Text>}
      {state.transfers.slice(0, 20).map((transfer) => <View key={`${transfer.assetId}:${transfer.idx}`} style={styles.item}>
        <View style={styles.row}>
          <Text style={styles.assetName}>{transfer.kind}</Text>
          <Text style={[styles.badge, transfer.status === 'Settled' && styles.success, transfer.status === 'Failed' && styles.error]}>{transfer.status}</Text>
        </View>
        <Text style={styles.text}>{state.assets.find((asset) => asset.assetId === transfer.assetId)?.ticker || transfer.assetId}</Text>
        {transfer.assignments.filter((assignment) => assignment.type === 'Fungible').map((assignment, index) =>
          <Text key={index} style={styles.text}>{assignment.amount} base units</Text>)}
        {!!transfer.createdAt && <Text style={styles.hint}>{new Date(transfer.createdAt * 1000).toLocaleString()}</Text>}
        <Text selectable style={styles.mono}>{transfer.txid || transfer.recipientId || `Transfer ${transfer.idx}`}</Text>
        {transfer.txid && <WalletButton title="Copy transaction ID" onPress={() => { void copy(transfer.txid!, 'Transaction ID'); }} />}
      </View>)}
      {state.transfers.length > 20 && <Text style={styles.hint}>Showing the 20 most recent transfers.</Text>}
      {!!state.burns.length && <Text style={styles.heading}>Website burn requests</Text>}
      {state.burns.map((record) => {
        const transfer = state.transfers.find((item) => item.txid === record.result?.txid && item.kind === 'Burn');
        const pending = record.state === 'pending';
        const cancelled = record.state === 'cancelled';
        const preparing = record.state === 'prepared';
        const running = pending && state.activeRequest === 'rgb_burnAsset';
        return <View key={`${record.metadata.origin}:${record.id}`} style={styles.item}>
          <Text style={styles.assetName}>Burn · {cancelled ? 'Cancelled before execution' : preparing ? 'Preparing' : pending ? (running ? 'Processing' : 'Outcome needs review') : (transfer?.status || 'Broadcast')}</Text>
          <Text style={styles.text}>{record.params.amount} base units · {record.metadata.origin}</Text>
          <Text selectable style={styles.mono}>{record.result?.txid || record.id}</Text>
          {pending && !running && <Text style={styles.error}>Inspect native history before another burn. This request will not be repeated automatically.</Text>}
        </View>;
      })}
    </>}

    {tab === 'Tools' && <>
      <Text style={styles.heading}>Receive setup</Text>
      <Text style={styles.text}>Fund your BTC address, then create receive UTXOs. Creating them uses a Bitcoin transaction at 2 sat/vB.</Text>
      <Text selectable style={styles.mono}>{state.address}</Text>
      <WalletButton title="Copy BTC address" onPress={() => { void copy(state.address, 'BTC address'); }} />
      {mockFaucetEnabled(state.network) && <>
        <Text style={styles.hint}>Regtest mock faucet · test tokens, no EVM backing.</Text>
        <WalletButton title="Get test BTC" disabled={disabled} onPress={() => { void demoWallet.mockFundOrMine('fund'); }} />
      </>}
      <WalletButton title="Prepare receive UTXOs" disabled={disabled} onPress={() => { void demoWallet.prepareReceive(); }} />
      {mockFaucetEnabled(state.network) && <WalletButton title="Mine 3 regtest blocks" disabled={disabled}
        onPress={() => { void demoWallet.mockFundOrMine('mine'); }} />}
      <Text style={styles.text}>{state.burnAvailable ? 'BFA burn and proof export are available for connected websites.' : 'BFA burn is unavailable with this native build or network configuration.'}</Text>
    </>}
    {!!feedback && <Text accessibilityLiveRegion="polite" style={styles.text}>{feedback}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  card: { padding: 16, gap: 14, borderWidth: 1, borderColor: C.border, borderRadius: 12, backgroundColor: C.bgCard },
  tabs: { flexDirection: 'row', gap: 3 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 8 },
  selectedTab: { backgroundColor: C.primaryBg, borderColor: C.primary },
  selectedText: { color: C.primary, fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 6 },
  group: { gap: 8 },
  heading: { color: C.textPrimary, fontSize: 18, fontWeight: '600' },
  assetName: { color: C.textPrimary, fontSize: 16, fontWeight: '600', flexShrink: 1 },
  text: { color: C.textSecondary, fontSize: 14, lineHeight: 21 },
  label: { color: C.textPrimary, fontSize: 14, fontWeight: '500' },
  hint: { color: C.textSecondary, fontSize: 12, lineHeight: 18 },
  value: { color: C.textPrimary, fontSize: 14, fontFamily: C.mono },
  mono: { color: C.textPrimary, fontSize: 12, fontFamily: C.mono, lineHeight: 19 },
  badge: { color: C.primary, fontSize: 12, flexShrink: 1 },
  item: { gap: 10, borderTopWidth: 1, borderColor: C.border, paddingTop: 14 },
  choice: { padding: 12, borderWidth: 1, borderColor: C.border, borderRadius: 8 },
  input: { color: C.textPrimary, backgroundColor: C.bgInput, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: C.border, minHeight: 46 },
  button: { backgroundColor: C.primaryBg, borderColor: C.primary, borderWidth: 1, padding: 13, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: C.textPrimary, fontWeight: '600', fontSize: 14 },
  disabled: { opacity: 0.4 },
  error: { color: C.error, lineHeight: 21 },
  success: { color: C.success },
});
