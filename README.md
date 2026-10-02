# rgb-sdk-rn Demo

For the **Wallet** tab and mobile dApp connection flow, see
[Wallet integration](docs/wallet-integration.md).

End-to-end demo app for [`@utexo/rgb-sdk-rn`](https://github.com/UTEXO-Protocol/rgb-sdk-rn). Runs four live integration flows on the **Flows** tab against a local regtest stack, a **Virtual Channel** flow (regtest and UTEXO signet) demonstrating `trusted_no_broadcast` RGB Lightning channels, a guided **UTEXO 2-Node Flow** on the **Utexo** tab (regtest or UTEXO/signet), **LSP** flows demonstrating inbound RGB liquidity via a Liquidity Service Provider (regtest and UTEXO signet), and **Async Payment (APay)** flows demonstrating Lightning Address checkout with offline-capable receive.

---

## What This Demo Shows

The demo runs all flows inside the app process — two or three RLN nodes start simultaneously on the device/emulator, connect to Bitcoin/Electrum/Proxy (local regtest or UTEXO signet), and execute real transactions. Everything visible in the Flows and Utexo screens is produced by actual SDK calls, not mocks.

---

## Required Infrastructure

### Recommended: `rgb-lightning-node` regtest stack

For **Flows** (regtest) and **Utexo → Regtest**, start the full local stack from [UTEXO-Protocol/rgb-lightning-node](https://github.com/UTEXO-Protocol/rgb-lightning-node):

```bash
git clone https://github.com/UTEXO-Protocol/rgb-lightning-node.git
cd rgb-lightning-node
git submodule update --init --recursive
./regtest.sh start
```

`./regtest.sh start` brings up **Bitcoin Core (regtest), Electrum, and RGB Proxy** only. It does **not** start the Bitcoin node helper.

### Services

**From `./regtest.sh start` (required for regtest flows):**

| Service | Default host:port | Purpose |
|---------|------------------|---------|
| Bitcoin Core (regtest) | `127.0.0.1:18443` (RPC) | Chain + wallet RPC for node unlock |
| Electrum indexer | `127.0.0.1:50001` | UTXO / transaction indexing |
| RGB Proxy | `127.0.0.1:3000` | RGB invoice transport (JSON-RPC) |

On **Android emulator** replace `127.0.0.1` with `10.0.2.2` for these hosts.

**Bitcoin node helper (optional, dev only — required for auto-fund / auto-mine):**

| Service | Default host:port | Purpose |
|---------|------------------|---------|
| Bitcoin node helper | `127.0.0.1:5000` | HTTP API — `mine` + `sendtoaddress` (used by demo, not part of upstream `regtest.sh`) |

The **Flows** tab and **Utexo → Regtest** call `sendToAddress()` and `mine()` in `utils/wallet-flow.ts`, which POST to that helper. Without it you must fund addresses and mine blocks yourself (e.g. `bitcoin-cli`).

### Bitcoin node helper (dev branch)

The SDK has no built-in way to mine or send regtest BTC — that is intentional. For local testing, run the helper from the **dev fork** (not included in [UTEXO-Protocol/rgb-lightning-node](https://github.com/UTEXO-Protocol/rgb-lightning-node) `main`):

```bash
git clone -b feat/external-signer https://github.com/bandrivskiy/rgb-lightning-node.git
cd rgb-lightning-node
git submodule update --init --recursive
./regtest.sh start          # Bitcoin + Electrum + proxy (upstream stack)
node local-node-bridge.js   # optional helper on :5000 — mine / sendtoaddress
```

Use the UTEXO-Protocol repo for `./regtest.sh start` if you only need the core stack; use the dev branch when you need `local-node-bridge.js` for automated funding in this demo.

Alternatively, run any HTTP server that wraps `bitcoin-cli` and exposes:

```
POST http://127.0.0.1:5000/execute
Content-Type: application/json

{ "args": "mine 6" }
{ "args": "sendtoaddress <address> 1" }
```

The helper wraps `bitcoin-cli` commands and returns JSON. You must implement or run this server yourself. A minimal Python example:

```python
from flask import Flask, request, jsonify
import subprocess, json

app = Flask(__name__)

@app.route('/execute', methods=['POST'])
def execute():
    args = request.json.get('args', '').split()
    result = subprocess.run(['bitcoin-cli', '-regtest', *args], capture_output=True, text=True)
    return jsonify({ 'result': result.stdout.strip(), 'error': result.stderr.strip() })

app.run(port=5000)
```

The demo's `sendToAddress()` and `mine()` helpers in `utils/wallet-flow.ts` call this endpoint and are the **only** demo-side pieces that interact with Bitcoin Core directly. The SDK never touches Bitcoin Core; it only connects through the Electrum indexer and the RPC unlock params.

---

## Environment Variables

Create a `.env.local` file in the project root (Expo reads `EXPO_PUBLIC_*` variables):

```bash
# Bitcoin Core RPC
EXPO_PUBLIC_RLN_BITCOIND_RPC_HOST=127.0.0.1      # 10.0.2.2 on Android emulator
EXPO_PUBLIC_RLN_BITCOIND_RPC_PORT=18443
EXPO_PUBLIC_RLN_BITCOIND_RPC_USERNAME=user
EXPO_PUBLIC_RLN_BITCOIND_RPC_PASSWORD=password

# Electrum indexer
EXPO_PUBLIC_RLN_INDEXER_URL=127.0.0.1:50001      # 10.0.2.2:50001 on Android emulator

# RGB Proxy
EXPO_PUBLIC_RLN_PROXY_ENDPOINT=rpc://127.0.0.1:3000/json-rpc

# Bitcoin node helper (optional — overrides default 127.0.0.1:5000)
BITCOIN_NODE_ENDPOINT=http://127.0.0.1:5000/execute
```

**UTEXO / signet (Utexo tab, UTEXO network):** add unlock credentials to `.env.local`

```bash
EXPO_PUBLIC_UTEXO_BITCOIND_RPC_USERNAME=
EXPO_PUBLIC_UTEXO_BITCOIND_RPC_PASSWORD=
EXPO_PUBLIC_UTEXO_BITCOIND_RPC_HOST=
EXPO_PUBLIC_UTEXO_BITCOIND_RPC_PORT=38332
EXPO_PUBLIC_UTEXO_INDEXER_URL=https://esplora-api.utexo.com
EXPO_PUBLIC_UTEXO_PROXY_ENDPOINT=rpcs://rgb-proxy.utexo.com/json-rpc
```

See `.env.utexo` in the repo root for the full template.

All values have sensible defaults so regtest flows will still attempt to connect with the defaults above if the file is missing. UTEXO mode requires real RPC credentials in `.env.local` (empty defaults will fail at unlock).

---

## Installation and Build

```bash
# 1. Install dependencies
npm install --install-strategy=nested

# 2. Build uniffi-bindgen-react-native (required once)
cd node_modules/uniffi-bindgen-react-native && npx tsc --project tsconfig.json && cd ../..

# 3. Generate native folders
npm run prebuild

# 4. iOS — install CocoaPods
cd ios && LANG=en_US.UTF-8 pod install && cd ..

# 5. Run in Release mode (flows require Release — native RLN does not run in Debug JS mode)
npm run ios:release
npm run android:release
```

> **Why Release?** Not because of Metro — the native code has no `#if DEBUG`
> branch, so port binding is identical in both configurations. The real
> constraint is that a **JS reload orphans the native nodes**: `RlnNodeStore` is
> a process-wide singleton with no bridge-invalidate hook, so Fast Refresh or `r`
> leaves the Rust nodes running with their ports bound and no JS handle left to
> reach them. Release is simply the configuration you never reload.
>
> Debug works fine if every reload is a process relaunch — build once with
> `npm run ios`, turn Fast Refresh off, then `npm run ios:relaunch`
> (`npm run android:relaunch` on the emulator) after each JS change.

### Clean build

```bash
npm run clean          # removes android/build, ios/build, metro cache
npm run ios:pod-install
npm run ios:release
```

---

## Port Allocation

Each node needs two TCP ports: a daemon HTTP port and an LDK peer-to-peer port. The demo assigns them randomly at flow start to avoid conflicts between concurrent runs:

```
nodeA: basePortA, basePortA+1
nodeB: basePortA+100, basePortA+101
nodeC: basePortA+200, basePortA+201
```

Ranges used per flow:

- Flow 1 (Channel + Payment): 20000–30000
- Flow 2 (3-node payment): 21000–26000
- Flow 3 (Ext signer asset channel): 20000–30000
- Flow 4 (Ext signer 3-node): 22000–27000
- Virtual Channel Regtest: 20000–30000
- Virtual Channel Signet: 43000–44000 (`43000 + random(0–999)`)

Make sure nothing else on your machine binds these ranges, or firewall rules don't block localhost loopback on them.

---

## Node Storage

Each node gets its own directory inside the app's `documentDirectory`:

```
<documentDirectory>/rln_wallet_chan_a_<timestamp>/   ← Flows tab nodes
<documentDirectory>/rln_wallet_chan_b_<timestamp>/
<documentDirectory>/vc_na_<timestamp>/               ← Virtual Channel regtest
<documentDirectory>/vc_nb_<timestamp>/
<documentDirectory>/vc_sig_na_<timestamp>/           ← Virtual Channel signet
<documentDirectory>/vc_sig_nb_<timestamp>/
```

These directories are created by the demo using `expo-file-system` before the SDK node is initialized. The SDK persists all node state (channels, keys, transfers) in these directories. Re-running a flow creates fresh directories with a new timestamp — the old ones remain on disk and must be cleaned manually if disk space is a concern.

---

## The Four Flows

### Flow 1 — UTEXOWallet: BTC Channel + Payment + Restart

**File:** `utils/wallet-flow.ts` → `runRlnUtexoWalletChannelPaymentFlow`

Two nodes, both using `PasswordRLNSigner`. Demonstrates the core `UTEXOWallet` lifecycle and the node restart pattern.

**What the SDK does:**

- `createWallet()` — derives xpubs and master fingerprint from a new mnemonic
- `new UTEXOWallet(params, new PasswordRLNSigner(password, mnemonic))` — constructs wallet with password-based signer
- `nodeA.init()` — creates the native node + writes key material to disk (first-time only)
- `nodeA.unlock(unlockParams)` — connects to Bitcoin Core, Electrum, and RGB Proxy
- `nodeA.getNodeInfo()` — reads pubkey, channel count, balance
- `nodeA.getAddress()` — get on-chain deposit address
- `nodeA.syncWallet()` — sync blockchain state after funding
- `nodeA.getBtcBalance()` — read BTC balances (vanilla + colored)
- `nodeA.createUtxos({ upTo: false, num: 10, feeRate: 7 })` — create RGB-ready UTXOs
- `nodeA.connectPeer(peerUri)` — connect `nodeA → nodeB`
- `nodeA.openChannel({ peerPubkeyAndOptAddr, capacitySat: 500_000, pushMsat: 0, public: false, withAnchors: true, assetId: null, assetAmount: null })` — open 500k sat BTC channel
- `nodeA.listChannels()` — poll until funding tx appears
- `nodeB.createLightningInvoice({ amountSats: 3000, expirySeconds: 900, asset: { assetId: '', amount: 0 } })` — BTC-only invoice
- `nodeA.payLightningInvoice({ lnInvoice })` — pay invoice
- `nodeA.getLightningSendRequest(paymentHash)` — poll until `'Settled'`
- `nodeA.shutdown()` — graceful stop, state preserved on disk
- `nodeA.reinit(unlockParams)` — restart on the same instance (no new `UTEXOWallet` needed)
- `nodeA.issueAssetNia({ ticker, name, precision, amounts })` — issue 1000 WCTS NIA asset
- `nodeB.witnessReceive({ minConfirmations: 1 })` — witness RGB invoice
- `nodeA.send({ invoice, assetId, amount: 500, donation: false, feeRate: 7, minConfirmations: 1 })` — on-chain RGB send (witness)
- `nodeB.blindReceive({ minConfirmations: 1 })` — blinded RGB invoice
- `nodeA.send(...)` — on-chain RGB send (blind)
- `nodeA.refreshWallet()` — sync RGB transfer state
- `nodeA.getAssetBalance(assetId)` — read spendable RGB balance
- `nodeA.destroy()` / `nodeB.destroy()` — shutdown + destroyNode + signer cleanup

**What the demo does (app side, not in SDK):**

- `sendToAddress(address, 1)` — calls Bitcoin node helper to fund the address
- `mine(6)` — calls Bitcoin node helper to mine confirmation blocks
- Directory creation with `FileSystem.makeDirectoryAsync`
- Polling loops (sync + `getNodeInfo`) to wait for channel to become usable after mining
- Random port assignment

**Expected result:** nodeA restarts cleanly on the same instance; both payments settle; final RGB balances verified.

---

### Flow 2 — UTEXOWallet: Asset Channel + 4 Payments + RGB On-Chain Sends

**File:** `utils/wallet-flow.ts` → `runRLNUtexoPaymentFlow`

Three nodes, all `PasswordRLNSigner`. Full RGB Lightning lifecycle: issue asset, open asset channel, 4 alternating payments, close, on-chain transfers.

**What the SDK does (in addition to Flow 1 basics):**

- `nodeA.issueAssetNia({ ticker: 'USDT', name: 'Tether', precision: 0, amounts: [1000] })` — issue 1000 units
- `nodeA.openChannel({ ..., assetId, assetAmount: 600 })` — open RGB asset channel placing 600 units
- `nodeA.getAssetBalance(assetId)` — confirm off-chain balance (≈400 remaining after open)
- 4 Lightning payments alternating A→B and B→A using `createLightningInvoice` + `payLightningInvoice` + `getLightningSendRequest`
- `nodeA.closeChannel(channelId, pubkeyB, false)` — cooperative close
- `nodeA.refreshWallet()` × 3 — sync RGB state during close sweep
- Poll `getAssetBalance()` until on-chain balances settle (A=950, B=50 expected, up to 5 min for sweep)
- `nodeC.blindReceive()` + `nodeA.send(925 units)` — on-chain RGB transfer A→C
- `nodeC.blindReceive()` + `nodeB.send(25 units)` — on-chain RGB transfer B→C
- Final balance check: A=25, B=25, C=950

**What the demo does (app side):**

- Same as Flow 1: fund all 3 nodes, mine blocks, poll for channel usable state
- Additional polling for cooperative close settlement (asset balances can take ~3 min after on-chain sweep)

---

### Flow 3 — UTEXOWallet: Regular Node Issues Asset + External Signer Invoices + Reverse Channel

**File:** `utils/wallet-flow.ts` → `runRlnUtexoWalletAssetChannelExtSignerFlow`

Two nodes: nodeA uses `PasswordRLNSigner` (issues asset, opens channel, pays); nodeB uses `NativeExternalRLNSigner` (creates invoices, receives). Demonstrates mixed signer types and the reverse-channel pattern.

**What the SDK does:**

- nodeA: `new UTEXOWallet(params, new PasswordRLNSigner(password, mnemonic))`
- nodeB: `new UTEXOWallet(params, new NativeExternalRLNSigner(mnemonic, network))`
  - `NativeExternalRLNSigner` converts the mnemonic to a 32-byte seed internally and creates a native VLS-backed signer — keys are held in native memory, not stored in JS
- nodeA issues 1000 USDT, opens 600-unit asset channel to nodeB
- 2 payments: nodeB creates invoices (100 + 50 units), nodeA pays each
- nodeA restarts (`shutdown` + `reinit`) between payment 1 and payment 2 — demonstrates that the external signer on nodeB survives the counterparty restart
- Cooperative close — poll until A=850, B=150 on-chain
- **Reverse channel:** nodeB opens a 100-unit asset channel back to nodeA (`nodeB.openChannel(...)`)
- 1 reverse payment: nodeA creates invoice (50 units), nodeB pays
- Close reverse channel — poll until A=900, B=100
- `nodeB.send(150 units)` on-chain back to nodeA
- Final: A=1000, B=0

**What the SDK does differently with `NativeExternalRLNSigner`:**

- `initNode` calls `rlnCreateNativeExternalSigner(seedHex, network)` → returns `signerId`
- Then calls `rlnInitNodeWithNativeExternalSigner(signerId)` instead of `rlnInitNode(password, mnemonic)`
- On restart: `rlnCreateNativeExternalSigner` again + `rlnAttachNativeExternalSigner` + `rlnUnlockNodeWithNativeExternalSigner`
- On destroy: `rlnDestroyNativeExternalSigner(signerId)`
- All of this is abstracted — the flow just calls `nodeB.init()` / `nodeB.unlock()` / `nodeB.destroy()` the same as any other wallet

**What the demo does (app side):** Same infrastructure helpers as above.

---

### Flow 4 — UTEXOWallet: External Signer NodeB — Full 3-Node Payment + RGB Sends

**File:** `utils/wallet-flow.ts` → `runRLNUtexoExternalPaymentFlow`

Identical scenario to Flow 2 (3-node, 1000 USDT, 4 payments, close, on-chain sends) but nodeB uses `NativeExternalRLNSigner`. Demonstrates that the full asset channel payment lifecycle works with an external signer as the channel acceptor.

**Key difference from Flow 2:**

- nodeB uses `NativeExternalRLNSigner` — VLS in-process signing
- `openChannel` uses `pushMsat: 0` — required when the acceptor has an external (VLS) signer; VLS rejects non-zero push on the acceptor side
- Everything else is the same SDK API surface

**Final balances:** A=25, B=25, C=950 (same as Flow 2)

---

## Virtual Channel Flows

Virtual channels use `trusted_no_broadcast` mode: the RLN daemon negotiates a channel with the counterparty and sets up the Lightning/RGB state machine, but the Bitcoin funding transaction is **never broadcast**. The channel exists purely in the nodes' in-memory state and is useful for off-chain asset transfers that settle without touching the chain.

**New SDK params required for virtual channels:**

```typescript
// Node that accepts inbound virtual channel opens must list the opener's pubkey
const nodeBWallet = new UTEXOWallet(
  {
    ...,
    enableVirtualChannelsV0: true,
    virtualPeerPubkeys: [nodaAPubkey],   // allow nodeA to open virtual channels
  },
  signer,
);

// Opener passes the virtual mode when calling openChannel
await nodeA.openChannel({
  peerPubkeyAndOptAddr: peerUri,
  capacitySat: 100_000,
  ...,
  assetId,
  assetAmount: 200,
  virtualOpenMode: 'trusted_no_broadcast',
});
```

`virtualPeerPubkeys` is `string[] | null`. Both nodes need `enableVirtualChannelsV0: true`; the acceptor additionally needs the opener's pubkey listed so it allows the channel. Without it LDK force-closes with `unsupported_scid_alias`.

---

### Virtual Channel — Regtest

**Files:** `screens/virtual-channel/config.ts`, `screens/virtual-channel/useVirtualChannelFlow.ts`, `screens/virtual-channel/index.tsx`

**Location in app:** Flows tab → Regtest sub-tab (bottom card)

**Infrastructure:** Same as the four regtest flows — `./regtest.sh start` + `local-node-bridge.js` on port `5000`.

**What it demonstrates:** Two nodes on the same device execute the full virtual channel lifecycle: issue RGB asset, connect peers, open a `trusted_no_broadcast` RGB channel, pay A→B, pay B→A. No funding transaction appears on-chain.

**Flow steps:**

| Phase | What happens |
|-------|-------------|
| `init` | Create Node A: `createWallet` + `UTEXOWallet` + `enableVirtualChannelsV0: true` |
| `init_b` | Create Node B: same + `virtualPeerPubkeys: [pubkeyA]` |
| `fund` | `sendToAddress(A, 0.3 BTC)` + `sendToAddress(B, 0.3 BTC)` + `mine(6)` + `createUtxos` on both |
| `issue` | Node A issues 1 000 VTST (NIA), polls until `settled > 0` |
| `connect` | `nodeA.connectPeer(nodeB)` |
| `open_channel` | `nodeA.openChannel({ capacitySat: 100 000, assetAmount: 200, virtualOpenMode: 'trusted_no_broadcast' })` |
| `wait_channel` | Poll `listChannels()` until both nodes see the channel as usable |
| `pay_ab` | Node B creates invoice (3 000 sat + 1 VTST); Node A pays |
| `settle_ab` | Poll until invoice `Succeeded` |
| `pay_ba` | Node A creates reverse invoice; Node B pays |
| `settle_ba` | Poll until reverse invoice `Succeeded` |

**Parameters:** `CHANNEL_CAPACITY_SAT = 100 000`, `CHANNEL_ASSET_AMOUNT = 200`, `PAYMENT_MSAT = 3 000 000`, `PAYMENT_ASSET_AMOUNT = 1`, `VIRTUAL_OPEN_MODE = 'trusted_no_broadcast'`

---

### Virtual Channel — UTEXO Signet

**Files:** `screens/virtual-channel-signet/config.ts`, `screens/virtual-channel-signet/useVirtualChannelSignetFlow.ts`, `screens/virtual-channel-signet/index.tsx`

**Location in app:** Flows tab → UTEXO sub-tab (bottom card)

**Infrastructure:** No local stack needed. Requires UTEXO signet credentials in `.env.local` (`EXPO_PUBLIC_UTEXO_*`) and two env vars for the automatic faucet:

```bash
EXPO_PUBLIC_FAUCET_URL=https://faucet.utexo.com/...
EXPO_PUBLIC_FAUCET_BEARER_TOKEN=<token>
```

**What it demonstrates:** Same virtual channel lifecycle as the regtest variant, but on UTEXO signet. Nodes are funded automatically via `sendToAddressUtexo()` (faucet API). No `mine()` calls — blocks arrive every ~100 s. All steps use polling with generous timeouts (up to 30 min for some phases).

**Flow steps:**

| Phase | What happens |
|-------|-------------|
| `init` | Create Node A: `createWallet('utexo')` + `UTEXOWallet(network: 'utexo', enableVirtualChannelsV0: true)` |
| `init_b` | Create Node B: same + `virtualPeerPubkeys: [pubkeyA]` |
| `fund` | Faucet → both addresses (60 000 sat each); poll until `settled > 0` (up to 15 min) |
| `utxos` | `createUtxos({ num: 5, size: 7 000, feeRate: 2 })` on both; poll until `spendable > 0` (up to 15 min) |
| `issue` | Node A issues 1 000 VTST; poll until `settled > 0` (up to 30 min) |
| `connect` | `nodeA.connectPeer(nodeB)` |
| `open_channel` | `nodeA.openChannel({ capacitySat: 31 000, assetAmount: 200, virtualOpenMode: 'trusted_no_broadcast' })` |
| `wait_channel` | Poll `listChannels()` (up to 30 min) |
| `pay_ab` | Node B invoices; Node A pays |
| `settle_ab` | Poll until `Succeeded` (up to 5 min) |
| `pay_ba` | Reverse payment B→A |
| `settle_ba` | Poll until `Succeeded` |

**Key signet-specific details:**

- `CHANNEL_CAPACITY_SAT = 31 000` (instead of 100 000) — rgb-lib's `send_begin` creates a PSBT with a `capacity_sat`-sized output using **only colored UTXOs** as inputs (`manually_selected_only`). With `size: 7 000` and 5 UTXOs = 35 000 sat colored BTC, the 31 000 sat output + ~2 000 sat fees fits; a 100 000 sat channel would not.
- `FAUCET_AMOUNT_SAT = 60 000` per node — funds `createUtxos` (~36 500 sat) with ~23 500 sat headroom.
- Faucet responses may timeout (HTTP) but BTC still arrives; the flow logs the timeout and continues to `pollFunded`.
- Both nodes store state in `<documentDirectory>/vc_sig_na_<ts>/` and `vc_sig_nb_<ts>/`.

**Parameters:** `CHANNEL_CAPACITY_SAT = 31 000`, `CHANNEL_ASSET_AMOUNT = 200`, `PAYMENT_MSAT = 3 000 000`, `PAYMENT_ASSET_AMOUNT = 1`, `FAUCET_AMOUNT_SAT = 60 000`, `VIRTUAL_OPEN_MODE = 'trusted_no_broadcast'`

---

## UTEXO 2-Node Flow (Utexo tab)

**File:** `app/(tabs)/utexo.tsx`

Interactive two-node walkthrough: **Init → Fund → UTXOs → Channel → Payments → Done**. Toggle **Regtest** or **UTEXO** at the top before **Start**.

| Mode | Network | Funding | Unlock config |
|------|---------|---------|---------------|
| **Regtest** | `regtest` | Automatic via `sendToAddress()` + `mine()` if **dev** `local-node-bridge.js` is running on `:5000`; otherwise fund/mine manually | `EXPO_PUBLIC_RLN_*` in `.env.local` (same as Flows tab) |
| **UTEXO** | `utexo` (signet) | Manual — send BTC to both addresses shown, or use Telegram [@Utexo_RLN_bot](https://t.me/Utexo_RLN_bot) `/getbtc <address>` | `EXPO_PUBLIC_UTEXO_*` in `.env.local` (template: `.env.utexo`) |

### Regtest

1. Start regtest infrastructure: `./regtest.sh start` from [rgb-lightning-node](https://github.com/UTEXO-Protocol/rgb-lightning-node) (or the dev fork above).
2. For auto-fund / auto-mine: on the [dev branch](https://github.com/bandrivskiy/rgb-lightning-node/tree/feat/external-signer), also run `node local-node-bridge.js` (helper on port `5000`).
3. Configure `.env.local` with `EXPO_PUBLIC_RLN_*` (use `10.0.2.2` on Android emulator).
4. Open the **Utexo** tab, select **Regtest**, tap **Start**.

The flow creates two `UTEXOWallet` instances (`PasswordRLNSigner`), funds both nodes, mines 6 blocks, creates RGB UTXOs, opens a BTC channel, and runs Lightning payments.

### UTEXO (signet)

1. Fill `EXPO_PUBLIC_UTEXO_*` in `.env.local` (RPC host, credentials, indexer, proxy — see `.env.utexo`).
2. Rebuild the app so env vars are embedded (`npm run android`).
3. Select **UTEXO**, tap **Start**, then fund **both** on-chain addresses (polls every 20s, up to 45 min).
4. Optional faucet: message [@Utexo_RLN_bot](https://t.me/Utexo_RLN_bot) with `/getbtc <address>` for each address.

Channel funding on signet waits for **6 confirmations** (~60 min); regtest confirms in seconds.

### SDK surface (same as Flows)

`createWallet` → `UTEXOWallet` + `PasswordRLNSigner` → `init` / `unlock` → `getAddress` / `syncWallet` / `getBtcBalance` → `createUtxos` → `connectPeer` / `openChannel` → `createLightningInvoice` / `payLightningInvoice` / `getLightningSendRequest`.

---

## LSP Flows

Two additional tabs demonstrate the **LSP (Liquidity Service Provider)** protocol — an external party opens an inbound RGB Lightning channel to the user node.

---

### LSP Signet (lsp-signet tab)

**File:** `app/(tabs)/lsp-signet/useLspFlow.ts`

Runs against the UTEXO public LSP (`https://lsp-signet.utexo.com`) on the **`utexo`** (signet) network. No local infrastructure is needed — just BTC on signet to fund the two nodes.

**What it demonstrates:**

1. **Inbound liquidity (Part 1):** NodeA connects to the LSP and waits for the LSP to open an RGB channel. NodeA calls `lspA.receiveAsset()` to get an RGB invoice + LN invoice. An external party sends RGB on-chain to the RGB invoice. The LSP then settles the LN invoice to deliver the asset over Lightning.
2. **A→B payment (Part 2):** NodeB also gets a channel from the LSP. NodeA pays NodeB via the LSP as a routing node.

**Environment variables:**

```bash
# Optional — defaults shown are the UTEXO public endpoints
EXPO_PUBLIC_LSP_URL=https://lsp-signet.utexo.com
EXPO_PUBLIC_SIGNET_ASSET_ID=rgb:YKIEjkhU-iqVFK0y-bfDUio6-bukqH7o-dxjctKB-5TuQ7aM
```

Both variables have built-in defaults so no `.env.local` is needed to try the flow.

**Running the flow:**

1. Open the **LSP Signet** tab and tap **Run**.
2. Fund **nodeA** address shown on screen (any signet BTC faucet, e.g. [@Utexo_RLN_bot](https://t.me/Utexo_RLN_bot) `/getbtc <address>`).
3. Fund **nodeB** address similarly.
4. Wait for LSP to open both channels (~6 signet confirmations, up to 30 min).
5. When prompted **MANUAL SEND REQUIRED** — send the exact RGB asset amount to the RGB invoice shown (use your own RGB-capable node or wallet).
6. Wait for the LN invoice to settle (~1–2 signet blocks after the LSP receives the asset).
7. Part 2 runs automatically once Part 1 settles.

**Key SDK calls:**

- `wA.createLsp()` — creates an `UtexoLSPClient` bound to `lspBaseUrl` from wallet params
- `lspA.connect()` — connects the node to the LSP peer
- `lspA.waitForChannel(assetId, { timeoutMs, pollIntervalMs, onProgress })` — polls until the LSP-opened RGB channel is usable
- `lspA.receiveAsset({ assetId, amountSats, amountRgb })` — calls `/lightning_receive` on the LSP; returns `{ lnInvoice, rgbInvoice }`
- `lspA.awaitReceiveSettlement(lnInvoice, { timeoutMs, pollIntervalMs, onProgress })` — polls invoice until `'Settled'`
- `lspA.waitForOutboundLiquidity(amountMsat, ...)` — polls until nodeA has enough outbound balance to send

---

### LSP Regtest (lsp-regtest tab)

**File:** `app/(tabs)/lsp-regtest/useLspFlow.ts`

Same LSP protocol but against a **local regtest** stack. Fully automated — the demo funds both nodes and mines blocks itself; no manual RGB send is needed (the Faucet RLN node sends on-chain instead).

**Infrastructure required:** Run `./scripts/start-lsp-regtest.sh` from the project root before launching the flow. This script:

1. Wipes and restarts `data_lsp` + `data_faucet` RLN nodes.
2. Issues a new RGB asset (UTST) on the Faucet node.
3. Seeds the LSP with 3 units from the Faucet.
4. Starts the `utexo-lsp` Go service with `SUPPORTED_ASSET_IDS` set to the new asset.
5. Writes the new asset ID + LSP pubkey to `.env.lsp.local` and `.env.local`.

**Services started by the script:**

| Service | Port | Command |
|---------|------|---------|
| LSP RLN node | 3005 (REST), 9737 (LDK) | `rgb-lightning-node data_lsp` |
| Faucet RLN node | 3008 (REST), 9740 (LDK) | `rgb-lightning-node data_faucet` |
| utexo-lsp (Go) | 8080 | `go run .` in `utexo-lsp/` |

Also requires the standard regtest stack (`./regtest.sh start` — Bitcoin Core, Electrum, RGB Proxy) and `local-node-bridge.js` on port `5000`.

**Android emulator — required port forwards:**

```bash
adb reverse tcp:3000 tcp:3000   # RGB Proxy  ← critical; missing this locks LSP UTXOs permanently
adb reverse tcp:3005 tcp:3005   # LSP RLN node
adb reverse tcp:5000 tcp:5000   # Bitcoin node helper
```

**Stopping:**

```bash
./scripts/start-lsp-regtest.sh stop
pkill -f "utexo-lsp"
```

**Common failure — `InsufficientAssets` / stuck Initiated Sends:**
The LSP cron fires every 5 s and calls `/openchannel` for every connected peer. If the RGB Proxy is unreachable from the emulator (missing `adb reverse tcp:3000`), each attempt creates an Initiated Send that locks a UTXO without settling. After all 3 seeded UTXOs are locked the LSP has `spendable=0` and permanently returns `InsufficientAssets`. Fix: set the port forward **before** connecting the app, then re-run `start-lsp-regtest.sh`.

---

## Async Payment (APay) Flows

Async payments let a **recipient receive RGB Lightning while offline at payment time**. The payer pays a HODL BOLT11 via LNURL (Lightning Address); the LSP holds the HTLC until the recipient is reachable, then the **LSP outbox** delivers automatically. The recipient app does **not** call `claimHodlInvoice`.

**Reference implementation:** `screens/apay/useApayFlow.ts`  
**Protocol details:** [`docs/apay-flow.md`](./docs/apay-flow.md) · SDK [`docs/async-payments.md`](https://github.com/UTEXO-Protocol/rgb-sdk-rn/blob/main/docs/async-payments.md)

**Location in app:** **LSP** tab → **Regtest** sub-tab (below the LSP regtest cards)

| Screen | File | What it demonstrates |
|--------|------|----------------------|
| **Async Payment** | `screens/async-pay.tsx` | Merchant registers a Lightning Address, goes offline; buyer pays via LNURL; merchant comes online for LSP outbox settlement |
| **APay Cart Checkout** | `screens/apay-regular-channels.tsx` | Same protocol as a cart checkout — merchant stays connected (`lsp.connect()` keepalive) while buyer pays |

Both screens call the same hook (`useApayFlow`) with different options (`variant: 'async'` vs `'cart'`).

### Infrastructure

Uses the **same LSP regtest stack** as [LSP Regtest](#lsp-regtest-lsp-regtest-tab) above:

```bash
./scripts/start-lsp-regtest.sh
# or: ./scripts/start-lsp-local.sh
```

Requires `EXPO_PUBLIC_LSP_REGTEST_ASSET_ID` (written to `.env.local` by the start script), plus Bitcoin Core, Electrum, RGB Proxy, and the node helper on `:5000`.

On **Android emulator**, set port forwards before running (included in `npm run android`):

```bash
adb reverse tcp:3000 tcp:3000   # RGB Proxy — required for channel open + consignment delivery
adb reverse tcp:8080 tcp:8080   # utexo-lsp (LNURL + APay HTTP)
adb reverse tcp:3005 tcp:3005   # Host RLN
adb reverse tcp:5000 tcp:5000   # Bitcoin node helper
```

The start script sets `DEFAULT_CHANNEL_PUSH_ASSET_AMOUNT=1` so the **buyer has local RGB** to pay. Without push, `payAddress` fails immediately with `Failed`.

### SDK calls (integrator checklist)

**Merchant (recipient):**

```typescript
await lsp.connect();
await lsp.waitForChannel(ASSET_ID, { … });
const { address } = await lsp.enableLightningAddress();
// While online / expecting payment: lsp.connect() periodically
// Settlement is automatic — poll listPaymentsRaw() for INBOUND_HODL → Succeeded
```

**Buyer (sender):**

```typescript
await lsp.connect();
await lsp.waitForChannel(ASSET_ID, { … });
await lsp.waitForOutboundLiquidity(PAYMENT_MSAT, { … });
const { invoice, sendResult } = await lsp.payAddress({
  address: merchantLightningAddress,
  amtMsat: PAYMENT_MSAT,
  asset: { assetId: ASSET_ID, assetAmount: 1 },
});
// Poll getLightningSendRequest(sendResult.txid) until Settled
```

**Success checks:** buyer `Settled`; merchant inbound `INBOUND_HODL` → `Succeeded`; merchant `offchainOutbound` increased.

---

## What the SDK Handles vs What the App Must Provide

### SDK handles

- Native RLN node lifecycle: create, init, unlock, shutdown, destroy, reinit
- Both signer types: `PasswordRLNSigner` (password + mnemonic) and `NativeExternalRLNSigner` (VLS in-process, seed never in JS)
- Key derivation: `createWallet()` → mnemonic, xpubVan, xpubCol, masterFingerprint
- BTC balance, address, UTXO management
- RGB asset issuance (NIA, CFA, IFA, UDA)
- Lightning channel open / close / keysend — including `virtualOpenMode: 'trusted_no_broadcast'`
- Virtual channel negotiation (`enableVirtualChannelsV0`, `virtualPeerPubkeys`)
- Lightning invoice create + pay + poll
- RGB Lightning payments (asset over LN)
- LSP composed flows (`UtexoLsp`: `connect`, `waitForChannel`, `receiveAsset`, `payAddress`, `enableLightningAddress`)
- Async payments / Lightning Address (APay): hash pool registration, LNURL checkout, LSP outbox settlement
- RGB on-chain send: `send()`, `blindReceive()`, `witnessReceive()`
- RGB transfer state: `refreshWallet()`, `listTransfers()`, `failTransfers()`
- Node info: peers, channels, network
- Fee estimation, backup

### App must provide

| Responsibility | How the demo does it | What a production app would do |
|----------------|---------------------|-------------------------------|
| Fund wallets | Bitcoin node helper HTTP API (`sendToAddress`) | User sends BTC to `getAddress()` result |
| Mine blocks | Bitcoin node helper HTTP API (`mine`) | Network produces blocks automatically |
| Storage directory | `expo-file-system` `makeDirectoryAsync` | `expo-file-system` or platform FS |
| Port selection | Random base port, +100/+200 per node | Fixed ports per node in app config |
| Wait for channel ready | Poll `getNodeInfo().numUsableChannels` + `mine` | Block explorer / webhook notification |
| Wait for balance settle | Poll `getAssetBalance()` with deadline | Push notification or polling |
| Signer key management | Pass mnemonic directly to signer constructor | Secure Enclave / Keystore backed store |
| Env / server config | `.env.local` + `EXPO_PUBLIC_*` | App settings UI or remote config |

---

## Key Patterns for Integration

### Wallet construction

```typescript
const keys = await createWallet('regtest');

const wallet = new UTEXOWallet(
  {
    storageDirPath,       // app-managed directory
    daemonListeningPort,  // app-assigned port
    ldkPeerListeningPort, // app-assigned port
    network: 'regtest',
    xpubVan: keys.accountXpubVanilla,
    xpubCol: keys.accountXpubColored,
    masterFingerprint: keys.masterFingerprint,
  },
  new NativeExternalRLNSigner(keys.mnemonic, 'regtest'),
  // or: new PasswordRLNSigner('password', keys.mnemonic)
);
```

### First-time init vs restart

```typescript
// First run — writes keys to disk
await wallet.init();
await wallet.unlock(unlockParams);

// App restart — same instance, same storage dir
await wallet.shutdown();
await wallet.reinit(unlockParams);  // createNode + unlock in one call

// Final cleanup
await wallet.destroy();
```

### Polling pattern for channel ready (app side)

```typescript
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  await wallet.syncWallet();
  const info = await wallet.getNodeInfo();
  if ((info.numUsableChannels ?? 0) >= 1) break;
  await new Promise(r => setTimeout(r, 2000));
}
```

### RGB send sequence

```typescript
// Receiver creates invoice
const invoice = await receiverWallet.blindReceive({ minConfirmations: 1 });

// Sender sends
await senderWallet.send({
  invoice: invoice.invoice,
  assetId,
  amount: 100,
  donation: true,
  feeRate: 1,
  minConfirmations: 1,
});

// Mine 1 block, then refresh both sides
await mine(1);
await senderWallet.refreshWallet();
await receiverWallet.refreshWallet();
```
