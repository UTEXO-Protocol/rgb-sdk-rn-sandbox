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

The user can also refresh balances, prepare receive UTXOs, and generate and
copy an invoice directly in the Wallet tab.

## Code structure

| File | Responsibility |
| --- | --- |
| `utils/wallet/connection.ts` | WalletKit lifecycle, pairing and sessions through `@utexo/webrgb-walletconnect` |
| `utils/wallet/provider.ts` | Connects the SDK's `WebRgbProvider` to the app's request queue and approval UI |
| `utils/wallet/service.ts` | Wallet actions, prompts and screen state |
| `utils/wallet/node.ts` | Opens the saved native wallet using credentials in SecureStore |
| `utils/wallet/storage.ts` | Persists burn records through the SDK's `BurnOperations` store |

WebRGB argument and result types come from `@utexo/webrgb`. The SDK provider is
imported from `@utexo/rgb-sdk-rn/webrgb`; the app does not implement another
WebRGB protocol mapping.

## Configuration

Set `EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID` in `.env.local` and restart Metro.
The Wallet tab uses `buildDemoWalletConfig()` in `utils/env.ts`:

- Normally it uses `EXPO_PUBLIC_UTEXO_NETWORK`, `EXPO_PUBLIC_UTEXO_INDEXER_URL`
  and `EXPO_PUBLIC_UTEXO_PROXY_ENDPOINT`.
- Burn and consignment require compatible native BFA bindings and an
  `EXPO_PUBLIC_UTEXO_ETH_RPC_URL`. The current build supports these on iOS.
  `EXPO_PUBLIC_DEMO_PAYOUT_CHAIN_IDS` sets permitted payout chains.
- Setting `EXPO_PUBLIC_DEMO_MOCK_FAUCET_URL` selects the local regtest stack
  and enables test funding/mining controls. This affects only the Wallet tab.
  The faucet server and its state are maintained outside this repository.

WebRGB and its WalletConnect adapter use the published npm packages
`@utexo/webrgb@^0.1.0` and `@utexo/webrgb-walletconnect@^0.1.0`.
The SDK still uses `file:../rgb-sdk-rn`: check out its `feat/walletconnect` branch
beside this repository and install and build it before installing the demo.
A compatible RLN release is still pending. Fresh iOS installations require a
compatible local archive or an explicit published version, as described in the
SDK's `docs/webrgb.md`. Follow the native build instructions in the main README
after those prerequisites are available.

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
