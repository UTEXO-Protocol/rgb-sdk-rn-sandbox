import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useIsFocused } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { buildDemoWalletConfig, DEMO_WALLET_NETWORKS } from '@/utils/env';
import { AppColors as C } from '@/constants/theme';
import { demoWallet, parseWalletConnectUri } from '@/utils/wallet';
import { describeWalletConfiguration } from '@/utils/wallet/node';
import { WalletOverview, WalletButton as Button } from '@/components/wallet-overview';

export default function WalletScreen() {
  const state = useSyncExternalStore(
    demoWallet.subscribe,
    demoWallet.snapshot,
    demoWallet.snapshot
  );
  const [uri, setUri] = useState('');
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [foreground, setForeground] = useState(
    AppState.currentState === 'active'
  );
  const [permission, requestPermission] = useCameraPermissions();
  const isFocused = useIsFocused();
  const handlingScan = useRef(false);
  const lastNetwork = useRef<typeof state.network | undefined>(undefined);
  const params = useLocalSearchParams<{ uri?: string }>();
  const router = useRouter();
  const walletBusy = state.busy || !!state.prompt || !!state.activeRequest;
  const networkLabel = DEMO_WALLET_NETWORKS.find(({ id }) => id === state.network)!.label;
  let initializationDetails = state.initializationDetails;
  try {
    initializationDetails ??= describeWalletConfiguration(buildDemoWalletConfig(state.network));
  } catch {
    initializationDetails = 'Wallet configuration is unavailable. Check the selected network settings.';
  }

  useEffect(() => { void demoWallet.initialize(); }, []);
  useEffect(() => {
    if (!state.networkLoaded) return;
    // Keep a launch deep link while the saved preference is still loading.
    if (lastNetwork.current && lastNetwork.current !== state.network) {
      setUri('');
      setError('');
      setScanning(false);
    }
    lastNetwork.current = state.network;
  }, [state.network, state.networkLoaded]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (value) =>
      setForeground(value === 'active')
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (typeof params.uri === 'string' && params.uri) {
      try {
        setUri(parseWalletConnectUri(params.uri));
        setError('');
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : 'Invalid connection link'
        );
      }
      router.setParams({ uri: '' });
    }
  }, [params.uri, router]);

  const connect = async (value = uri) => {
    if (pairing || state.prompt) return;
    setPairing(true);
    setError('');
    setScanning(false);
    try {
      await demoWallet.pair(value);
      setUri('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect');
    } finally {
      setPairing(false);
    }
  };
  const scan = async () => {
    setError('');
    try {
      const access = permission?.granted ? permission : await requestPermission();
      if (!access.granted) {
        setError(
          'Camera access is needed to scan. You can paste the connection URI instead.'
        );
        return;
      }
      handlingScan.current = false;
      setScanning(true);
    } catch {
      setError('Camera is unavailable. Paste the connection URI from Mint UI.');
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={state.refreshing || false} tintColor={C.primary}
          enabled={state.ready && !walletBusy}
          onRefresh={() => { void demoWallet.refresh(); }} />}
      >
        <Text style={styles.title}>Wallet</Text>
        <Text style={styles.subtitle}>
          Your RGB assets, invoices and connected websites.
        </Text>
        <View style={styles.card}>
          <Text style={styles.heading}>Network</Text>
          <View style={styles.networks} accessibilityRole="radiogroup">
            {DEMO_WALLET_NETWORKS.map(({ id, label }) => (
              <Pressable
                key={id}
                accessibilityRole="radio"
                accessibilityState={{ checked: state.network === id, disabled: walletBusy || pairing || !state.networkLoaded }}
                disabled={walletBusy || pairing || !state.networkLoaded}
                onPress={() => { void demoWallet.selectNetwork(id); }}
                style={[styles.network, state.network === id && styles.selectedNetwork,
                  (walletBusy || pairing || !state.networkLoaded) && styles.disabled]}
              >
                <Text style={[styles.text, state.network === id && styles.selectedText]}>{label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.text}>
            {state.network === 'utexo'
              ? 'Utexo signet uses the shared Utexo test network.'
              : 'Local regtest requires your own running indexer and RGB proxy. On a physical iPhone, use your computer’s LAN address instead of 127.0.0.1.'}
          </Text>
          <Text style={styles.heading}>Wallet parameters</Text>
          <Text style={styles.text}>{state.initializationDetails
            ? 'Parameters used for the last wallet open attempt. Restart the app after changing environment variables.'
            : 'Parameters for the next wallet open.'}</Text>
          <Text selectable style={styles.endpoint}>{initializationDetails}</Text>
          <Text style={styles.text}>
            Changing networks disconnects websites. Each network keeps its own wallet and history.
          </Text>
        </View>
        <View style={styles.card}>
          <Text style={styles.heading}>
            {state.ready
              ? `Wallet ready · ${networkLabel}`
              : 'Demo RGB wallet'}
          </Text>
          {!state.ready && (
            <Text style={styles.text}>
              Open a separate wallet for this demo. It is saved on this device
              and reused after restarting the app.
            </Text>
          )}
          {!state.ready && (
            <Button
              title={state.busy ? 'Opening…' : 'Open wallet'}
              onPress={() => {
                void demoWallet.start();
              }}
              disabled={state.busy || !state.networkLoaded}
            />
          )}
          {state.ready && (
            <>
              <Button
                title={state.refreshing ? 'Refreshing…' : 'Refresh wallet'}
                disabled={walletBusy}
                onPress={() => { void demoWallet.refresh(); }}
              />
              <Text style={styles.text}>{state.updatedAt
                ? `Updated ${new Date(state.updatedAt).toLocaleTimeString()}`
                : 'Balances have not loaded yet.'}</Text>
            </>
          )}
        </View>
        {error || state.error ? (
          <Text accessibilityRole="alert" selectable style={styles.error}>{error || state.error}</Text>
        ) : null}
        {!!state.message && <Text accessibilityLiveRegion="polite" style={styles.text}>{state.message}</Text>}
        {(state.busy || !!state.activeRequest) && <ActivityIndicator color={C.primary} />}
        {!!state.activeRequest && <Text style={styles.text}>
          Website request: {state.activeRequest.replace('rgb_', '')} · {state.prompt ? 'Awaiting your approval' : 'Processing'}
        </Text>}
        {state.lastRequest && <Text selectable style={state.lastRequest.status === 'failed' ? styles.error : styles.text}>
          Last website action: {state.lastRequest.method.replace('rgb_', '')} · {state.lastRequest.status}
          {state.lastRequest.error ? `\n${state.lastRequest.error}` : ''}
        </Text>}
        {state.ready && <WalletOverview key={state.network} state={state} />}
        <View style={styles.card}>
          <Text style={styles.heading}>Connect to website</Text>
          <Text style={styles.text}>
            On the bridge page, select UtexoWallet. Scan its QR here or paste
            the wc:… connection URI. The website must use the same network ({state.network}).
          </Text>
          <Text style={styles.text}>
            On iOS Simulator, paste the connection URI or use the Open Demo Wallet link.
          </Text>
          <Button
            title="Scan QR"
            disabled={!state.ready || pairing || walletBusy}
            onPress={() => {
              void scan();
            }}
          />
          <TextInput
            accessibilityLabel="WalletConnect connection URI"
            placeholder="wc:…"
            placeholderTextColor={C.textTertiary}
            value={uri}
            onChangeText={setUri}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            style={styles.input}
            editable={!pairing}
          />
          <Button
            title={pairing ? 'Connecting…' : 'Connect'}
            disabled={!state.ready || !uri.trim() || pairing || walletBusy}
            onPress={() => {
              void connect();
            }}
          />
          {pairing && <ActivityIndicator color={C.primary} />}
        </View>
        {state.sessions.map((session) => (
          <View key={session.topic} style={styles.card}>
            <Text style={styles.heading}>{session.peer.metadata.name}</Text>
            <Text selectable style={styles.text}>
              {session.peer.metadata.url}
            </Text>
            <Text style={styles.text}>Connected · {state.network}</Text>
            <Button
              title="Disconnect"
              onPress={() => {
                void demoWallet
                  .disconnect(session.topic)
                  .catch((cause) => setError(String(cause)));
              }}
            />
          </View>
        ))}
      </ScrollView>
      <Modal
        visible={scanning && isFocused && foreground}
        onRequestClose={() => setScanning(false)}
        animationType="slide"
      >
        <SafeAreaView style={styles.root}>
          <Text style={styles.scanTitle}>Scan the Mint UI connection QR</Text>
          {scanning && isFocused && foreground && permission?.granted && (
            <CameraView
              style={styles.camera}
              onMountError={() => {
                setScanning(false);
                setError('Camera is unavailable. Paste the connection URI from Mint UI.');
              }}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                if (handlingScan.current) return;
                handlingScan.current = true;
                setUri(data);
                void connect(data);
              }}
            />
          )}
          <View style={styles.content}>
            <Button title="Cancel scan" onPress={() => setScanning(false)} />
          </View>
        </SafeAreaView>
      </Modal>
      <Modal
        visible={!!state.prompt}
        transparent
        animationType="fade"
        onRequestClose={() => state.prompt?.resolve(false)}
      >
        <View style={styles.overlay}>
          <View style={styles.dialog}>
            <Text style={styles.heading}>{state.prompt?.title}</Text>
            <Text selectable style={styles.origin}>
              {state.prompt?.origin}
            </Text>
            <ScrollView>
              <Text style={styles.text}>{state.prompt?.details}</Text>
            </ScrollView>
            <Button
              title="Approve"
              onPress={() => state.prompt?.resolve(true)}
            />
            <Button
              title="Reject"
              onPress={() => state.prompt?.resolve(false)}
            />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bgBase },
  content: { padding: 20, gap: 16 },
  title: { color: C.textPrimary, fontSize: 28, fontWeight: '700' },
  subtitle: { color: C.textSecondary, fontSize: 15, lineHeight: 22 },
  card: {
    backgroundColor: C.bgCard,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 14,
  },
  networks: { flexDirection: 'row', gap: 10 },
  network: { flex: 1, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: C.border, borderRadius: 8 },
  selectedNetwork: { borderColor: C.primary, backgroundColor: C.bgInput },
  selectedText: { color: C.primary, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  endpoint: { color: C.textTertiary, fontFamily: C.mono, fontSize: 12, lineHeight: 20 },
  heading: { color: C.textPrimary, fontSize: 18, fontWeight: '600' },
  text: { color: C.textSecondary, fontSize: 14, lineHeight: 22 },
  input: {
    color: C.textPrimary,
    backgroundColor: C.bgInput,
    minHeight: 96,
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    textAlignVertical: 'top',
    fontFamily: C.mono,
  },
  error: { color: C.error, lineHeight: 22 },
  scanTitle: { color: C.textPrimary, fontSize: 18, padding: 20 },
  camera: { flex: 1 },
  overlay: {
    flex: 1,
    backgroundColor: '#000b',
    justifyContent: 'center',
    padding: 24,
  },
  dialog: {
    maxHeight: '85%',
    backgroundColor: C.bgCardElevated,
    borderRadius: 16,
    padding: 20,
    gap: 18,
  },
  origin: { color: C.primary, fontSize: 16 },
});
