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

Receive invoices default to at least **3 hours** (180 minutes) in both wallet
tabs. The local form accepts 180–43,200 minutes. WalletConnect requests with an
omitted or shorter positive duration use 3 hours; longer valid durations are
preserved. The approval prompt shows the effective duration. This leaves time
for bridge preparation before its required one-hour mint window. Existing
invoices keep their original expiry; generate a new invoice after updating.

## Burn directly in the wallet

1. Open **Wallet → Burn**, or tap **Burn** on a BFA asset in **Assets**.
2. Select the asset, enter a token amount (not base units), or use **Max**.
   Enter the payout chain and recipient address: an EVM chain ID (`1`, `42161`)
   with a `0x…` address, or a Tron chain (`tron:728126428`; Shasta
   `tron:2494104990`, Nile `tron:3448148188`) with a `T…` Base58Check address.
3. Tap **Review burn** and approve the asset, amount, network, recipient and
   Bitcoin fee in the confirmation dialog. The wallet uses the same defaults as
   website burns: 2 sat/vB and at least 3 confirmations. Keep BTC available for fees.
4. The transaction ID and payout details appear in Burn and Activity. This is a
   Bitcoin burn, not confirmation of the payout. Connect the wallet to the
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

The demo currently uses the local `../rgb-sdk-rn` checkout (the `feat/rgb-lib-bfa`
branch, initially reviewed at `56e3624`, plus the local podspec packaging fix). The package keeps version
`1.0.0-beta.39`, but the published beta.39 does not include this new backend.
`package.json` uses `file:../rgb-sdk-rn`; npm links the adjacent checkout,
including its already-installed native bindings. Metro watches that checkout;
TypeScript, autolinking and Node tests resolve the same SDK. Run `npm install`
in this demo. The prepared local checkout is required on other machines. After an SDK update,
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
`@utexo/webrgb@^0.1.3` and `@utexo/webrgb-walletconnect@^0.1.3`.
The SDK pins RLN `0.17.0-beta.3`. Install with `npm install --install-strategy=nested`;
on macOS the SDK downloads the iOS bindings during installation, and Android
resolves its bindings through Gradle. Follow the native build instructions in
the main README after installing.

## Separate RGB Lib tab

**Wallet** continues to use `new UTEXOWallet(params, signer)` (`RGB_LN`), with
its existing SecureStore key, directory, network preference, WalletConnect
prefix and burn journal. Existing credentials are neither replaced nor migrated.

**RGB Lib** creates `new UTEXOWallet({ protocol: 'RGB_L1', params, keys })`.
It provides balances, asset and pending-transfer history, receive invoices,
receive UTXO preparation, refresh and WalletConnect. It has separate keys,
a `wallet-connect-v1/RGB_L1/<network>/default/taproot` directory, network
preference and WalletConnect storage. Both services can remain open: changing
one tab's network does not stop or disconnect the other. An approval badge
indicates a pending request on an inactive tab; only the focused tab shows its
confirmation dialog.

The shared UI is `components/wallet-screen.tsx`; each route passes its own
service. `utils/wallet/profiles.ts` selects the opener and persistence namespaces.
`utils/wallet/rgb-lib-node.ts` persists the mnemonic before native initialization
and reads it through `CallbackRgbLibKeyProvider`. RGB Lib account identifiers
use the `RGB-L1-` prefix (CAIP account characters do not allow underscores).
Failed native cleanup retains the handle and must succeed before another open.

Configure a deployment compatible with the pinned rgb-lib release explicitly:

```dotenv
EXPO_PUBLIC_RGB_LIB_UTEXO_INDEXER_URL=https://esplora-api.utexo.com
EXPO_PUBLIC_RGB_LIB_UTEXO_PROXY_ENDPOINT=rpcs://rgb-proxy.dev.utexo.com/json-rpc
# BFA mint validation requires an RPC for the source EVM chain:
EXPO_PUBLIC_RGB_LIB_UTEXO_EVM_RPC_URLS={"42161":"https://arb1.arbitrum.io/rpc"}

# Alternatively, configure the Local regtest selection:
EXPO_PUBLIC_RGB_LIB_REGTEST_INDEXER_URL=tcp://your-regtest-host:50001
EXPO_PUBLIC_RGB_LIB_REGTEST_PROXY_ENDPOINT=rpc://your-compatible-proxy:3000/json-rpc
# EXPO_PUBLIC_RGB_LIB_REGTEST_EVM_RPC_URLS={"31337":"http://your-regtest-evm:8545"}
```

For this local setup, **Utexo signet** uses the indexer and dev proxy above,
configured separately in `.env.local`. On 2026-10-21 the indexer responded
successfully, and the dev proxy's `server.info` reported `protocol_version: "1.0"`
and server version `0.3.0`. This matches the protocol required by the pinned
rgb-lib revision. This check confirms the protocol version; a funded transfer
has not been verified. The RLN proxy at `rgb-proxy.utexo.com` reports protocol
`0.2` and remains confined to Wallet. Regtest and EVM URLs above are placeholders.

RLN endpoints and its unkeyed `ethRpcUrl` are never automatically reused.
For a BFA mint from Arbitrum, RGB Lib needs the explicit `42161` entry above.
Without it, the native log reports `Cannot resolve mint events: no EVM RPC URL
configured for chain ID 42161, will retry`; the transfer remains pending and
the asset is not added. After changing this configuration, reload the app and
reopen RGB Lib before refreshing the existing transfer. Refresh reports pending
transfers and surfaces per-batch failures returned by the SDK.
The RLN mock faucet tools are also confined to Wallet; fund RGB Lib through its
configured Bitcoin network. Missing configuration appears on the tab with the
specific environment variable names. Restart Metro after setting them. The website must support `RGB_L1` on the same network; the deep
link is `myapp://rgb-lib?uri=…`. WebRGB advertises the SDK's on-chain methods.
Bridge burn/payout controls and message signing are unavailable in this mode
until proof interoperability is established; native BFA support alone is not
sufficient. RLN burn behavior is unchanged.

Install the local dependency and rebuild (Expo Go cannot load native bindings):

```sh
# From this demo:
npm install
npm run ios:pod-install
npm run ios
# Or npm run android
```

The adjacent SDK already contains the prepared iOS frameworks and Android AAR
in `ios/RgbLibBindings` and `android/rgb-lib-maven`. The local link uses them
directly; this demo needs no bindings environment variable or installer script.
On a fresh machine, prepare the SDK checkout according to its own native build
instructions. Rebuild the SDK after editing its TypeScript and rebuild the app
after native changes.

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


Local dual-backend verification covers the existing RLN flows plus profile
isolation, pending unknown-asset receives, failed cleanup/retry, explicit RGB Lib
configuration and WebRGB capability gating. Native verification also checks
that the final iOS app embeds both `RGBLib.framework` and `rgb_libFFI.framework`.
The SDK podspec must not use `exclude_files = "ios/RgbLibBindings/**/*"`:
CocoaPods applies that exclusion to vendored frameworks too and silently builds
the unavailable-backend fallback. The local fix limits source/header globs to
files directly under `ios/` instead.

The SDK's native iOS smoke test checks coexistence with RLN, profile locks,
invoices/history, reopening and encrypted backup/restore on an isolated
simulator. It does not validate a live deployment or a funded RGB transfer.
