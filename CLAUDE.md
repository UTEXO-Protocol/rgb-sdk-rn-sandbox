# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

End-to-end integration demo for `@utexo/rgb-sdk-rn`. An Expo + Expo Router app that runs four live RGB Lightning flows (plus VSS flows) against a local regtest stack — two or three on-device RLN nodes execute real transactions inside the app process.

The SDK is consumed from **npm** — `"@utexo/rgb-sdk-rn": "1.0.0-beta.34"`, which pulls `@utexo/rgb-sdk-core@1.0.0-beta.9`. A clone plus `npm install` is enough; no sibling checkout is required.

Metro uses the installed npm packages. Local SDK development requires explicitly switching the dependency to `file:../rgb-sdk-rn` and adding the linked SDK directories to `watchFolders`.

## Commands

```bash
# Install (nested strategy required to avoid duplicate react/react-native instances)
npm install --install-strategy=nested

# Generate native iOS/Android folders (must run after fresh install or dependency changes)
npm run prebuild

# iOS
cd ios && LANG=en_US.UTF-8 pod install && cd ..
npm run ios:release          # Release; for Debug see the note below
npm run ios:open             # open Xcode workspace

# Android
npm run android:release      # Release; for Debug see the note below

# Clean builds
npm run clean                # removes android/build, ios/build, metro cache
npm run ios:pod-install      # re-runs pod install

# Lint
npm run lint
```

> **Release builds are the safe default, but Debug works — under one rule.**
> The native code has no `#if DEBUG` branch: the daemon binds its ports
> identically in both configurations. What breaks Debug is **JS reloads**, not
> Metro. `RlnNodeStore.shared` (`ios/RlnNodeStore.swift` in the SDK) is a
> process-wide singleton and `Rgb.mm` registers no bridge `invalidate`/`dealloc`
> hook, so a Fast Refresh or `r` rebuilds the JS context while the Rust nodes
> keep running — ports bound, LDK peers connected, storage dirs locked — with no
> JS handle left to reach them and nothing to clean them up. `destroy()` does not
> clear the native registration either; only a process kill does (see
> `research/dispose.md`).
>
> So in Debug: **one JS-context lifetime = one flow run.** Turn Fast Refresh off
> and make every reload a process relaunch:
>
> ```bash
> npm run ios          # Debug build, once — no native rebuild after this
> # edit JS, then:
> npm run ios:relaunch # terminate + launch: new bundle, clean native state
> ```
>
> (`npm run android:relaunch` is the same for the emulator.) Pressing `r` in
> Metro or letting Fast Refresh fire is what produces the "appears to start but
> silently fails or hangs" behaviour — the orphaned nodes accumulate with each
> reload.

## Environment Setup

Two env file templates exist:

- **`.env`** — regtest defaults (Bitcoin Core on `127.0.0.1`, Electrum on `50001`, RGB Proxy on `3000`, Bitcoin node helper on `5000`)
- **`.env.utexo`** — UTEXO public network credentials template; copy to `.env.utexo.local` and fill in values

Create `.env.local` to override regtest values. Android emulator needs `10.0.2.2` instead of `127.0.0.1` for all services. All `EXPO_PUBLIC_*` variables are read by `readEnv()` in `utils/wallet-flow.ts`.

Key variables:
```
EXPO_PUBLIC_RLN_BITCOIND_RPC_HOST / PORT / USERNAME / PASSWORD
EXPO_PUBLIC_RLN_INDEXER_URL         (e.g. 127.0.0.1:50001)
EXPO_PUBLIC_RLN_PROXY_ENDPOINT      (e.g. rpc://127.0.0.1:3000/json-rpc)
EXPO_PUBLIC_RLN_VSS_URL             (optional, e.g. http://127.0.0.1:8081/vss)
BITCOIN_NODE_ENDPOINT               (e.g. http://127.0.0.1:5000/execute)
```

## Required Infrastructure

All flows require four services running locally before hitting **Run**:

| Service | Default | Purpose |
|---------|---------|---------|
| Bitcoin Core (regtest) | `127.0.0.1:18443` | Block production, wallet funding |
| Electrum indexer | `127.0.0.1:50001` | UTXO/tx indexing |
| RGB Proxy | `127.0.0.1:3000` | RGB invoice transport |
| Bitcoin node helper | `127.0.0.1:5000` | HTTP API wrapping `bitcoin-cli` for `mine` and `sendtoaddress` |

The Bitcoin node helper is a tiny HTTP server (minimal Python/Flask example in `README.md`). The demo's `mine()` and `sendToAddress()` in `utils/wallet-flow.ts` are the only pieces that call it — the SDK itself never touches Bitcoin Core directly.

## Architecture

### Metro configuration (`metro.config.js`)

Uses the installed npm SDK without watching sibling checkouts. `nodeModulesPaths` points to the demo's `node_modules`.

`@utexo/rgb-sdk-core` is resolved with `createRequire` from the installed RN SDK. Both the main entry and `./conformance` are mapped to their installed files so direct demo imports work with the nested npm layout. No sibling core version is forced.

### Flow runner (`utils/wallet-flow.ts`)

Contains all six flow functions and the shared infrastructure helpers:

- `runRlnUtexoWalletChannelPaymentFlow` — Flow 1: BTC channel, payment, node restart
- `runRLNUtexoPaymentFlow` — Flow 2: RGB asset channel, 4 payments, cooperative close, on-chain sends
- `runRlnUtexoWalletAssetChannelExtSignerFlow` — Flow 3: mixed signers (password + native external), reverse channel
- `runRLNUtexoExternalPaymentFlow` — Flow 4: same as Flow 2 but nodeB uses `NativeExternalRLNSigner`
- `runRlnUtexoVssFlow` / `runRlnVssFlow` — VSS backup/restore flows

**Flow guard:** `beginExclusiveFlow` / `endExclusiveFlow` prevent concurrent flows by tracking `activeDemoFlow`. Flows must run sequentially — running two simultaneously corrupts node state.

**Step tracking:** Every flow uses `createFlowResults()` which returns `addStep(name, status, data?, error?)`. Steps are upserted by name so the UI can update in-place.

### Port allocation

Each flow picks a random base port and allocates ports as:
```
nodeA: base, base+1
nodeB: base+100, base+101
nodeC: base+200, base+201
```
Ranges per flow: Flow 1 / Flow 3 use 20000–30000; Flow 2 uses 21000–26000; Flow 4 uses 22000–27000.

### Node storage

Each node gets a directory created via `expo-file-system` before `UTEXOWallet` is constructed:
```
<documentDirectory>/rln_wallet_chan_a_<timestamp>/
<documentDirectory>/rln_wallet_chan_b_<timestamp>/
```
Fresh directories are created per flow run (timestamp suffix). Old directories accumulate on disk.

### App screens (`app/(tabs)/`)

- `flows.tsx` — primary screen; buttons to run each flow, live step log, SDK utility tests
- `utexo.tsx` — UTEXO network tab
- `lsp-regtest.tsx` — full LSP e2e flow (lightning_receive Part 1 + User A pays User B Part 2)
- `lsp.tsx` — LSP flow against UTEXO public network
- `index.tsx` — home

### Key plugin

`plugins/withExcludeX86SimulatorArch.js` — Expo config plugin that strips x86_64 slice from simulator builds so the arm64-only `RGBLightningNode.xcframework` links correctly on Apple Silicon Macs.

## LSP Flow (`app/(tabs)/lsp-regtest.tsx`)

Implements `test_flow0_full_e2e` from `utexo-lsp/tests/e2e/tests/test_flow0_full_e2e.py`.

**What it demonstrates:**
- Part 1: User A receives RGB inbound liquidity via the LSP (`lightning_receive` protocol) — an external sender (faucet in regtest) sends RGB on-chain to the LSP, LSP delivers it to User A over a Lightning channel.
- Part 2: User A pays User B — proves outbound liquidity works. LSP opens a channel to User B, User B creates an invoice, User A pays via the LSP as a routing node.

**Infrastructure required:** Run `./scripts/start-lsp-regtest.sh` before launching the flow. This script:
1. Wipes and restarts `data_lsp` + `data_faucet` RLN nodes fresh
2. Issues **two** RGB assets on the Faucet node — NIA `UTST` (precision 0) and IFA `UTIF` (precision 6)
3. Seeds the LSP with `SEED_ROUNDS` (6) allocations of the **active** asset (`ASSET=utst|ifa`), `SEED_UNITS` base units apiece
4. Starts `utexo-lsp` (Go service) with `SUPPORTED_ASSET_IDS` set to the active asset only — see the one-session-per-peer note below
5. Writes both asset IDs (+ ticker, precision) and the LSP pubkey to `.env.lsp.local`, `.env.local` and `e2e-fixtures.json`

**Key services and ports:**

| Service | Port | Binary/command |
|---------|------|---------------|
| LSP RLN node | 3005 (REST), 9737 (LDK peer) | `rgb-lightning-node data_lsp` |
| Faucet RLN node | 3008 (REST), 9740 (LDK peer) | `rgb-lightning-node data_faucet` |
| utexo-lsp (Go) | 8080 | `go run .` in `utexo-lsp/` |
| RGB Proxy | 3000 | Docker (part of regtest stack) |
| Bitcoin node helper | 5000 | `local-node-bridge.js` |

**Android emulator port forwards (all required):**
```bash
adb reverse tcp:8081 tcp:8081   # Metro JS
adb reverse tcp:8082 tcp:8082   # Metro HMR
adb reverse tcp:3000 tcp:3000   # RGB Proxy ← critical for RGB consignment delivery
adb reverse tcp:3005 tcp:3005   # LSP RLN node
adb reverse tcp:5000 tcp:5000   # Bitcoin node helper
```
These are set automatically by `npm run android` (via `adb wait-for-device &&` prefix).

**Stopping the LSP stack:**
```bash
./scripts/start-lsp-regtest.sh stop
pkill -f "utexo-lsp"  # stop script misses compiled binaries
```

**Common failure: `InsufficientAssets` / stuck Initiated Sends**
The `utexo-lsp` cron fires every 5s and calls `/openchannel` on the LSP node for every connected peer. If the RGB consignment can't be delivered (proxy not reachable from emulator), the channel open creates an Initiated Send that locks a UTXO but never settles. After 3 such failures all 3 seeded UTXOs are locked → `spendable=0` → permanent `InsufficientAssets`.
Fix: ensure `adb reverse tcp:3000 tcp:3000` is set before connecting the app to the LSP, then re-run `start-lsp-regtest.sh`.

**Root cause of `CounterpartyForceClosed: Failed to find RGB consignment`**
This is the underlying error behind the stuck sends — the app node rejects the channel because it can't fetch the RGB consignment from the proxy. Always set the proxy port forward before running the LSP flow.

**The same error in the other direction: never put `10.0.2.2` in a node's `proxyEndpoint`.**
A node's proxy endpoint is not only dialled by that node. When it funds an RGB channel the endpoint travels to the counterparty, which fetches the consignment from it. An app node unlocked with `rpc://10.0.2.2:3000/json-rpc` therefore tells the LSP — a process on the dev machine — to look for the consignment at an address that only means something inside the emulator. The LSP finds nothing and closes the channel ~10 s after accepting it.

The tell is that **the proxy log shows the `consignment.post` but no matching `consignment.get`**: the fetch was attempted, it just never reached this proxy. Measured over a full stack run, 59 of 61 channel-open consignments were fetched normally; the 2 that were not were exactly the two channels an Android app node funded.

Only Android is affected — an iOS node says `127.0.0.1`, which is correct for both sides. Fix: `PROXY_HOST` in `screens/apay/config.ts` pins port 3000 to `127.0.0.1` on both platforms, which works from the device thanks to `adb reverse tcp:3000 tcp:3000`. bitcoind (18443) and electrs (50001) have no reverse forward and are dialled only by the device, so they keep `10.0.2.2`.

The same trap applies to any `transport_endpoints` array handed to a host-side daemon — see `toDaemonUrl()` next to `PROXY_HOST`.

## APay cart flows — two assets, one LSP

`screens/apay/useApayFlow.ts` is asset-agnostic: pass an `ApayAsset` (`screens/apay/config.ts`) and it drives the whole checkout. Two profiles ship:

| Profile | Asset | Precision | Checkout | Screen |
|---------|-------|-----------|----------|--------|
| `UTST_ASSET` | NIA `UTST` | 0 | 3000 sat + 1 UTST | `screens/apay-regular-channels.tsx` |
| `IFA_ASSET` | IFA `UTIF` | 6 | 1 sat + 500 000 base units (0.5 UTIF) | `screens/apay-ifa.tsx` |

`apay-ifa.tsx` is a thin wrapper around the cart screen with a different asset, storage prefix and port bases (48000/50000) — the flow code is shared, not copied.

**Amounts are always base units.** Every RGB/LSP API (`receiveAsset.amountRgb`, `payAddress.asset.assetAmount`, `sendrgb` assignments) takes 10^-precision units; `precision` only affects display. `formatAssetAmount()` in `screens/apay/config.ts` renders them.

**One asset per stack run — this is a hard constraint, not a preference.** `virtual_channel_add_intent` (rgb-lightning-node `src/ldk.rs`) rejects a second virtual channel to a peer it already has a session with, and the check ignores the asset entirely:

```
openchannel failed for 03eadf98…: virtual channel session already exists for this peer pair
```

So an LSP advertising two assets in `SUPPORTED_ASSET_IDS` opens a channel for whichever the cron reaches first and leaves every flow for the other asset polling until its channel timeout. The script therefore serves exactly one:

```bash
./scripts/start-lsp-regtest.sh             # UTST
ASSET=ifa ./scripts/start-lsp-regtest.sh   # UTIF
```

Both assets are issued on the faucet either way (so the fixtures and `.env.local` stay complete), but only the active one is seeded to the LSP and advertised. `EXPO_PUBLIC_LSP_REGTEST_ACTIVE_ASSET` tells the app which; the flows check it up front and refuse with the command to run rather than burning 180 s in `waitForChannel`.

`DEFAULT_CHANNEL_ASSET_AMOUNT` is a single global in utexo-lsp, so the script sizes it for the precision-6 asset (1 000 000 base units = 1.0 UTIF, and harmlessly 1 000 000 whole UTST) and seeds ~120 channels' worth.

### Bridge-asset checkout (`TWO_ASSETS=1`)

`TWO_ASSETS=1 ./scripts/start-lsp-regtest.sh` (old name `LINKED_ASSET=1` still
works) swaps the single UTIF issuance for two assets and enables
`screens/apay-linked-asset.tsx`:

| | asset | issued on | role |
|---|---|---|---|
| payout | `LNUSDT` | **Faucet**, seeded to the LSP | merchant's channel + delivery; the only `SUPPORTED_ASSET_IDS` |
| bridge | `BUSDT` | **Faucet** | what the buyer receives on-chain and funds its own channel with; `CONVERTIBLE_ASSET_IDS` only |

**Both are ordinary IFA contracts with no relationship to each other.** What
makes them interchangeable is one utexo-lsp setting, `CONVERTIBLE_PAIRS`
(`<asset>|<asset>`, `|` because contract ids already contain `rgb:`), and that
list is the entire authorization for the 1:1 rate.

The pair used to be an RGB Asset Link, which forced the LSP to issue `LNUSDT`
itself: `linked_to_asset_id` and the parent's settled `Link` transfer live only
in the wallet that ran `link_ifa` and never travel in a consignment — measured in
`docs/linked-asset-bridge-test-report.md` §5.2, where the LSP received 100 % of
both assets' supply and still saw neither. utexo-lsp no longer looks for any of
it (`internal/lspapi/convertible_asset.go`, `ensureConvertiblePair`): it checks
that both assets are payout-eligible, that the pair is declared, and that the
precisions match. See §10 of `docs/apay-linked-asset-options.uk.md`.

The script still sends the LSP a 1-unit bootstrap transfer of `BUSDT`, now for a
different reason: the bridge asset is never seeded, so without it the LSP's node
403s `UnknownContractId` on `/assetmetadata` and discovery cannot advertise the
asset's ticker/precision before the buyer's channel exists.

The payment is **option A** of `docs/apay-linked-asset-options.uk.md`: no
node-level swap (the invoice is hosted, so the payee is the LSP and
`find_linked_asset_channel` drops every one of the buyer's channels). utexo-lsp
quotes the buyer in `BUSDT`, pays the merchant `LNUSDT`, and converts 1:1 between
the two legs of one APay payment; one shared payment hash keeps them atomic.

Which asset gets quoted is the payer's call, made in the SDK: `payAddress` with
an `asset.assetAmount` but no `assetId` runs `UtexoLsp.selectPaymentAsset`, which
reads `payout_asset` / `accepted_assets` off LNURL discovery and picks the payout
asset when local liquidity covers the amount, an accepted asset otherwise.
Conversion is the fallback, never the default — quoting the payout asset trusts
the LSP for delivery only, converting also trusts it for the second leg's amount.
Liquidity is compared per channel, not summed: there is no cross-asset MPP.

### Paying from a node that has never heard of APay

The LNURL callback is unauthenticated and payer-agnostic, and the invoice it
returns is *hosted*: utexo-lsp signs it with its own key against a hash the
receiver pre-registered (`internal/lspapi/lightning_address.go`,
`handleLightningAddressCallback`). Nothing in it names the payer, and the RGB
contract id and amount ride inside the BOLT11 — `send_payment` reads them back
out of `invoice.rgb_contract_id()` (`rgb-lightning-node/src/routes.rs`). So any
RGB Lightning node with a channel to the LSP in the quoted asset can settle it
with a bare `POST /sendpayment {"invoice": …}`, no SDK and no LNURL involved.

`UtexoLsp.requestExternalInvoice()` is the receiver side of that: it quotes the
BOLT11 and hands it back instead of paying it. The asset is resolved from LNURL
discovery, not from `.env` — `listPayableAssets()` returns the address's payout
asset plus every convertible one with tickers, and `requestExternalInvoice` takes
a **ticker** (`'BUSDT'`) or nothing, defaulting to the single convertible asset.
`/get_info` is the wrong source here and always will be: `supported_assets` is
built from `SUPPORTED_ASSET_IDS`, which by design excludes the bridge asset.

Each quote reserves a hash from the receiver's APay batch, so an invoice that is
quoted and never paid still costs one — call `enableLightningAddress()` first and
refill off `unusedHashes`. The screen's **External-payer invoice** toggle runs the
checkout this way: the merchant quotes, and the buyer settles the raw BOLT11 with
`payLightningInvoice`, which is all an external node would do.

### Receiving on-chain in one asset, over Lightning in another

`/lightning_receive` runs the same conversion in the opposite direction: the
sender pays canonical USDT on-chain and the receiver is delivered LNUSDT over its
channel. Nothing in the delivery path needed changing — the stored asset is only
used to watch the inbound transfer (`transferStatusByIdx`), and delivery just
pays the receiver's BOLT11, whose own asset picks the channel.

Which asset the RGB invoice is issued in is the **LSP's** decision, not the
client's: `rgb_invoice.asset_id` is now optional, and omitting it resolves the
counterpart from `CONVERTIBLE_PAIRS` (one → take it, several → 400, none → same
asset as before). `receiveAsset()` therefore omits it by default
(`onchainAsset: 'convertible'`) and never needs the canonical asset's contract
id; `onchainAsset: 'payout'` restores one-asset-end-to-end.

A converted receive pins the inbound amount — `{"type":"Fungible","value":N}`
instead of the usual `Any` — because two unrelated contracts have nothing else
tying what arrives on-chain to what the BOLT11 pays out, and the LSP would cover
the gap from its own inventory. Same-asset receives keep `Any`.

No virtual channels anywhere in this mode: the LSP node starts without
`--enable-virtual-channels-v0` and `VIRTUAL_OPEN_MODE` is empty, so
`MIN_AMT_MSAT` falls back to 3 000 000 and the checkout carries 3 000 sat. The
other APay cart flows will not work against this stack.

**Both directions, and who gets a channel.** The flow ends with a refund: the
merchant pays the buyer back through APay, quoting `LNUSDT` (all it holds) while
the buyer is delivered `BUSDT`. Four utexo-lsp settings make that possible, all
set by the script under `TWO_ASSETS=1`:

- `CONVERTIBLE_ASSET_IDS` — assets the LSP accepts and pays out over a channel
  the peer funded itself, but never provisions. Putting the bridge asset in
  `SUPPORTED_ASSET_IDS` instead would give every peer a second channel
  (`connectionsFromPeers` loops assets inside the peer loop), burn inventory in
  an asset the LSP does not issue, and make every peer's payout asset ambiguous.
- `CONVERTIBLE_PAIRS` — which assets may differ between the two legs. Being
  payout-eligible is not enough; the pair has to be declared, in either
  direction, and the same entry serves the checkout and the refund.
- `PAYOUT_ASSET_PREFERENCE` — tie-break for a peer that ended up with channels in
  two payout-eligible assets. Without it the LSP refuses to guess.
- `CHANNEL_PROVISION_GRACE` (30s here) — the cron provisions a peer only in its
  own payout asset, and holds off entirely on a peer first seen moments ago with
  no channels, which is exactly what a client looks like between its `connect`
  and its own funding tx.

The RGB amount rides an HTLC, so the LSP also needs **sats** on its side of the
buyer's channel to deliver anything: the buyer opens with `aChannelPushMsat`
(10 000 sat) because a channel opened at 0 leaves the LSP with only the
checkout's 3 000 sat, of which the 1% channel reserve is unspendable — the refund
then fails as `NoRoute` with the asset balance untouched.

### The same flow on signet (`screens/apay-linked-asset-signet/`)

The UTEXO tab's copy of the bridge-asset checkout, against a utexo-lsp deployed
from `utexo-lsp/.env.signet` — the production equivalent of `TWO_ASSETS=1`. Same
six legs, same SDK calls, same amounts: the regtest script was sized off
`.env.signet` in the first place, so `CHANNEL_ASSET_AMOUNT`,
`CHANNEL_CAPACITY_SAT` and `CHANNEL_PUSH_MSAT` match on both networks and the
5-unit checkout is the same number. **What differs is time, not money.**

| | regtest | signet |
|---|---|---|
| blocks | mined on demand | ~30 s, unprompted |
| `CHANNEL_PROVISION_GRACE` | 30 s | **60 s** |
| `CRON_EVERY` | 5 s | 10 s |
| BTC funding | `sendToAddress` + `mine(6)` | faucet `/sendbtc`, then poll |
| channel wait | 240 s | 30 min |
| LN settlement | 120 s | 15 min |
| on-chain RGB leg | 300 s | 45 min |

Assets default to the two ids in `.env.signet`: payout `LNUSDT`
(`SUPPORTED_ASSET_IDS`) and bridge `USDT` (`CONVERTIBLE_ASSET_IDS`) — the latter
is the same contract `screens/apay-signet` already calls `ASSET_ID`, because on
signet the canonical USDT *is* the convertible asset. Override with
`EXPO_PUBLIC_SIGNET_BRIDGE_PAYOUT_ASSET_ID` / `EXPO_PUBLIC_SIGNET_BRIDGE_ASSET_ID`.

Three things the signet flow does that regtest does not need:

- **A preflight.** `/get_info` is checked for the served asset and its precision,
  for the Lightning-Address sendable range against all four legs, and for
  `virtual_channel_mode` being *empty* (a non-empty value means this is the
  single-asset signet LSP, not the two-asset one). The faucet's BTC and bridge-asset
  balances are checked too — it is the on-chain source of `USDT`, and there is no
  script to issue it. Every one of these costs 20+ minutes to discover later.
- **The peer URI comes from `/get_info`** (`host`/`port`), not from a constant.
  `createLsp()` still gets the peer explicitly, for the regtest reason:
  the no-arg form calls `enableVirtualChannelsForPeer()`, and this deployment has
  no virtual channels, so the merchant's public regular channel would be rejected
  as `unsupported_scid_alias`.
- **`createUtxos` is waited on via `colored.settled`**, not `spendable`. rgb-lib
  defines `spendable = future − immature` and `future = confirmed + unconfirmed`
  (`_get_btc_balance`, `wallet/offline.rs`), so `spendable` counts an unconfirmed
  batch and is not a confirmation signal at all — `settled` is `balance.confirmed`
  alone. The buyer runs `createUtxos` twice (its blind receive burns one UTXO), so
  the wait compares against a reading taken just before each call rather than
  against zero.

No endpoint rewriting anywhere: signet wallets unlock against the public
`rgb-proxy.utexo.com`, which means the same thing to the device, the faucet and
the LSP. `toDaemonUrl()` and `PROXY_HOST` are regtest/emulator-only.

### `MIN_AMT_MSAT` and the 1-sat HTLC

`rgb-lightning-node` has two per-HTLC floors (`src/core_types.rs`):
- `HTLC_MIN_MSAT = 3_000_000` — regular channels. An RGB payment rides the HTLC output, and a dust-trimmed HTLC on a broadcastable commitment cannot settle the asset.
- `VIRTUAL_HTLC_MIN_MSAT = 1_000` — `trusted_no_broadcast` (virtual) channels. Never broadcast, so no dust limit applies.

The virtual floor is applied consistently on every leg: channel open (`our_htlc_minimum_msat`, `routes.rs`/`sdk/mod.rs`), invoice creation (`htlc_min_msat_for_asset`), sends/keysend (`htlc_min_msat_for_peer`) and the APay `request_outbound_invoice` handler (`ldk.rs`). The acceptor keeps LDK's default 1 msat, and utexo-lsp never subtracts a fee — the outbound leg must equal the reserved `amount_msat`. So **1 sat works end to end on virtual channels**, and `start-lsp-regtest.sh` defaults `MIN_AMT_MSAT=1000` whenever `VIRTUAL_OPEN_MODE` is set (falling back to 3 000 000 when it is not).

`LIGHTNING_ADDRESS_MIN_SENDABLE_MSAT` has to track it — the SDK validates `payAddress` against LNURL discovery's `minSendable`, not against `MIN_AMT_MSAT`, so leaving it at the 3 000 000 default would reject a 1-sat checkout client-side. `maxSendable` is set to the per-HTLC ceiling utexo-lsp itself derives (`capacity × PEER_MAX_INBOUND_HTLC_IN_FLIGHT_PERCENT`).

## LSP-related SDK bugs fixed (in `@utexo/rgb-sdk-core`, moved out of `../rgb-sdk-rn`)

### `UtexoLSPClient` snake_case mismatch (`rgb-sdk-core/src/lsp/UtexoLSPClient.ts`)

`utexo-lsp` returns JSON with snake_case keys (`rgb_invoice`, `ln_invoice`, `mapping_id`, `num_channels`, etc.). The SDK's `request<T>()` does a plain `JSON.parse()` with no key transformation, so camelCase type fields come back as `undefined` unless explicitly mapped.

Fixed in `lightningReceive()` by introducing `LspLightningReceiveWire` type and explicitly mapping keys:
```ts
const raw = await this.request<LspLightningReceiveWire>('/lightning_receive', ...);
return {
  lnInvoice:  raw.ln_invoice  ?? raw.lnInvoice  ?? '',
  rgbInvoice: raw.rgb_invoice ?? raw.rgbInvoice ?? '',
  mappingId:  String(raw.mapping_id ?? raw.mappingId ?? ''),
};
```

**Status (verified 2026-08-06):** all previously-flagged endpoints are now fixed — `getInfo()` maps every snake_case field explicitly (`apiVersion`, `supportedAssets`, `minPaymentSizeMsat`, etc.), `onchainSend` response has its own wire type + mapping, and `ApayNewResponse` now goes through the native P2P binding (already camelCase, consistent on both platforms) so the REST variant's mismatch is moot.

## What the App Must Provide (vs SDK)

The SDK never touches Bitcoin Core or the filesystem directly. The app owns:
- Creating node storage directories (`FileSystem.makeDirectoryAsync`)
- Funding wallets (`sendToAddress` → Bitcoin node helper)
- Mining confirmation blocks (`mine` → Bitcoin node helper)
- Port assignment per node
- Polling loops for channel readiness (`getNodeInfo().numUsableChannels`) and balance settlement (`getAssetBalance()`)
- Env variable parsing (`readEnv()` wrapper around `process.env.EXPO_PUBLIC_*`)

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
