# Wallet integration

The **Wallet** tab demonstrates a mobile RGB wallet connected to a dApp through
WalletConnect. It opens a saved wallet, shows balances and transfers, creates
receive invoices, and asks the user to approve connection, invoice, burn and
consignment requests.

## Request flow

```text
dApp → WalletConnect → WebRGB adapter → SDK WebRgbProvider → UTEXOWallet
```

1. Open the wallet, scan or paste the dApp's WalletConnect URI, and approve the
   session. A `myapp://wallet?uri=…` deep link uses the same connection flow.
2. The dApp calls `blindReceive`. After approval, the wallet creates an RGB
   invoice and returns it to the dApp for mint or another incoming transfer.
3. The dApp calls `burnAsset`. The wallet shows the asset, amount, recipient and
   fee, then executes the approved burn and saves its result.
4. `getConsignment` returns the proof to the dApp after permission to share it.
   The dApp handles bridge submission; the wallet does not call `/unlock`.

The user can also refresh balances, prepare receive UTXOs, generate and copy an
invoice, and burn BFA assets directly in the Wallet tab without a website session.

## Burn directly in the wallet

1. Open **Wallet → Burn**, or tap **Burn** on a BFA asset in **Assets**.
2. Select the asset, enter a token amount (not base units), or use **Max**.
   Enter the EVM payout chain ID and recipient address.
3. Tap **Review burn** and approve the asset, amount, network, recipient and
   Bitcoin fee in the confirmation dialog. The wallet uses the same defaults as
   website burns: 2 sat/vB and at least 3 confirmations. Keep BTC available for fees.
4. The transaction ID and payout details appear in Burn and Activity. This is a
   Bitcoin burn, not confirmation of an EVM payout. Connect the wallet to the
   bridge and choose **Existing burn → From wallet** to retrieve its consignment
   and request the payout. The wallet never submits `/unlock` itself.

Local and website burns share the SDK's `BurnOperations`, native-operation queue
and account-scoped durable journal. Local records use `local:wallet` as their
origin; a website still needs approval to export those proofs. Rejecting the
confirmation does not burn. An unresolved native outcome blocks further burns;
refresh retries persistence without repeating the transaction. Available balance
is checked again after approval, and decimal amounts are converted without rounding.

## Code structure

| File | Responsibility |
| --- | --- |
| `utils/wallet/connection.ts` | WalletKit lifecycle, pairing and sessions through `@utexo/webrgb-walletconnect` |
| `utils/wallet/provider.ts` | Connects the SDK's `WebRgbProvider` to the app's request queue and approval UI |
| `utils/wallet/service.ts` | Wallet actions, prompts and screen state |
| `utils/wallet/node.ts` | Opens the saved native wallet using credentials in SecureStore |
| `utils/wallet/storage.ts` | Persists burn records through the SDK's `BurnOperations` store |
| `utils/wallet/burn.ts` | Local burn input validation, exact amounts and payout details |
| `components/wallet-burn.tsx` | Local burn form and saved transaction details |

WebRGB argument and result types come from `@utexo/webrgb`. The SDK provider is
imported from `@utexo/rgb-sdk-rn/webrgb`; the app does not implement another
WebRGB protocol mapping.

The demo uses the published `@utexo/rgb-sdk-rn@1.0.0-beta.37`.
Run `npm install --install-strategy=nested` after updating the dependency.
Metro and Node tests use its published entry points. After an SDK update,
regenerate the native projects and rebuild the app with `npm run ios` or
`npm run android`.

Transfer amounts come directly from the SDK. Its shared mapper preserves
`requestedAssignment`, computes outgoing amounts per transfer and exposes exact
`amountBaseUnits` strings. The demo provider forwards those results unchanged;
Activity displays the SDK amount. There is no burn-journal amount fallback or
proxy that rewrites assignments. Burns without a known amount stay unknown.

## Configuration

Set `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID` in `.env.local` and restart Metro.
The Wallet tab has an explicit **Utexo signet / Local regtest** selector and
remembers the selected network on this device. It defaults to Utexo signet
(`utexo`), including when a mock faucet URL is configured. Selecting a network
before opening the wallet only updates local preferences.

The Wallet tab uses `buildDemoWalletConfig(selectedNetwork)` in `utils/env.ts`:

- Utexo signet uses `EXPO_PUBLIC_UTEXO_INDEXER_URL` (default
  `https://esplora-api.utexo.com`) and `EXPO_PUBLIC_UTEXO_PROXY_ENDPOINT`
  (default `rpcs://rgb-proxy.utexo.com/json-rpc`). Its network ID is always
  `utexo`; `EXPO_PUBLIC_UTEXO_NETWORK` still applies to other demo screens.
- Burn and consignment require compatible native BFA bindings and an
  `EXPO_PUBLIC_UTEXO_ETH_RPC_URL`. The published SDK supports these on iOS and Android.
  The payout chain comes from the burn request and is shown in the wallet confirmation.
- Local regtest uses the host in `EXPO_PUBLIC_DEMO_MOCK_FAUCET_URL` when set
  (indexer port 51211, RGB proxy port 31210) and enables test funding/mining
  controls. Otherwise it uses `buildRegtestConfig()` and the existing
  `EXPO_PUBLIC_RLN_INDEXER_URL` / `EXPO_PUBLIC_RLN_PROXY_ENDPOINT` settings.
  On a physical iPhone use a reachable LAN hostname/IP, not `127.0.0.1`.
  The faucet server and its state are maintained outside this repository.

Switching an open wallet disconnects RGB WalletConnect sessions, shuts down the
old native node, and opens the selected network. Switching is unavailable while
an operation or approval is active. Keys, native directories and burn journals
remain separate, using their existing storage keys/paths. Switching back reuses
the saved wallet and restarts its SDK instance. A failed connection leaves the
selected network visible with an error and an Open wallet retry button.

The website must request the same network. For the bridge frontend set
`VITE_UTEXO_WALLET_NETWORK=utexo` for Utexo signet, or `regtest` for the local
stack; restart Vite after changing its environment and reconnect the website.

WebRGB and its WalletConnect adapter use the published npm packages
`@utexo/webrgb@^0.1.2` and `@utexo/webrgb-walletconnect@^0.1.2`.
The SDK pins RLN `0.16.0-beta.3`. Install with `npm install --install-strategy=nested`;
on macOS the SDK downloads the iOS bindings during installation, and Android
resolves its bindings through Gradle. Follow the native build instructions in
the main README after installing.

## Recovery and checks

Wallet keys, native data and burn records survive app restarts. Refresh retries
saving a known burn result without repeating the burn. If the app exits before
the native result is saved, the operation stays pending until its proof can be
verified; the current native build cannot do that reconciliation automatically.

```sh
npm run test:walletconnect
npx tsc --noEmit
```

These tests cover wallet lifecycle, request handling and persistence, including
the real adapter and SDK provider with a simulated wallet backend. Native calls
are disabled in Node tests; live relay and device testing are separate.
