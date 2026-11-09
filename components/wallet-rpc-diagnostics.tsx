import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AppColors as C } from '@/constants/theme';
import { checkEvmRpc } from '@/utils/wallet/rpc-diagnostics';
import { WalletButton } from './wallet-overview';

export function WalletRpcDiagnostics({ endpoint, nativeError }: { endpoint: string; nativeError: string }) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState('');
  const [feedback, setFeedback] = useState('');
  const check = async () => {
    setBusy(true); setFeedback('');
    try { setReport(JSON.stringify({ ...(await checkEvmRpc(endpoint)), nativeError }, null, 2)); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try {
      const Clipboard = await import('expo-clipboard');
      await Clipboard.setStringAsync(report);
      setFeedback('Connection diagnostics copied.');
    } catch { setFeedback('Long-press the report to copy it.'); }
  };
  return <View style={styles.card}>
    <Text style={styles.heading}>RPC connection diagnostics</Text>
    <WalletButton title={busy ? 'Checking RPC…' : 'Check RPC connection'} disabled={busy} onPress={() => { void check(); }} />
    {!!report && <>
      <Text selectable style={styles.report}>{report}</Text>
      <WalletButton title="Copy connection diagnostics" onPress={() => { void copy(); }} />
    </>}
    {!!feedback && <Text style={styles.text}>{feedback}</Text>}
  </View>;
}
const styles = StyleSheet.create({
  card: { backgroundColor: C.bgCard, borderColor: C.border, borderWidth: 1, borderRadius: 16, padding: 16, gap: 12 },
  heading: { color: C.textPrimary, fontSize: 18, fontWeight: '600' },
  text: { color: C.textSecondary, fontSize: 14 },
  report: { color: C.textSecondary, fontSize: 12, fontFamily: 'monospace' },
});
