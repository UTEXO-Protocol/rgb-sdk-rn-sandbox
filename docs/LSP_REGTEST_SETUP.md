# LSP Regtest Setup

## Repos you need

Clone these three repos side by side (e.g. all under `~/rgb/`):

```bash
git clone https://github.com/UTEXO-Protocol/rgb-lightning-node.git
git clone https://github.com/UTEXO-Protocol/utexo-lsp.git
git clone https://github.com/UTEXO-Protocol/rgb-sdk-rn-demo.git
```

```
rgb-lightning-node/   ← regtest docker stack + RLN binary
utexo-lsp/            ← Go LSP service
rgb-sdk-rn-demo/      ← this repo, demo app
```

`rgb-lightning-node` is used as-is — no extra files committed there.

---

## Prerequisites

```bash
# macOS
brew install go jq node docker

# Rust (for building the RLN binary)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

---

## Step 1 — Prepare the RLN checkout

Use an RLN checkout compatible with the native framework bundled in the app.
Build it once when installing or explicitly upgrading RLN:

```bash
cd /absolute/path/to/rgb-lightning-node
cargo build --release --locked --bin rgb-lightning-node --target-dir ./target
```

The setup script reuses `RGBLN_REPO/target/release/rgb-lightning-node`; it does
not build or update RLN. Updating the checkout alone does not update that binary.
Unlock uses explicit `ldk_chain_sync.mode=BlockSync` with Bitcoin RPC credentials
inside `ldk_chain_sync.config`; `indexer_url` configures the RGB wallet separately.
Both setup `/rgbinvoice` requests include the required `transport_endpoints`
array. The Go service receives the same local proxy through
`RGB_INVOICE_TRANSPORT_ENDPOINTS=rpc://127.0.0.1:3000/json-rpc`.

---

## Step 2 — Set environment variables

Export these in your shell (add to `~/.zshrc` / `~/.bashrc` to persist):

```bash
export RGBLN_REPO=/absolute/path/to/rgb-lightning-node
export UTEXO_LSP_REPO=/absolute/path/to/utexo-lsp
```

The setup script refuses to start without both. `RGBLN_REPO` is also how the
bitcoin bridge locates the docker compose project.

Use compatible versions of RLN, utexo-lsp and the app's native SDK.
`RGBLN_REPO` must contain the release binary built in Step 1.

---

## Step 3 — Run the setup script

Each setup run deletes `data_lsp`, `data_faucet` and the LSP database and issues
new asset IDs. It creates a fresh test environment; it does not preserve channels.

**This one command is the whole setup.** It starts the regtest docker stack
(bitcoind, electrs, proxy) if it is not already up, and starts
`local-node-bridge` on `:5000` itself — you do not need to run `./regtest.sh
start` or `node scripts/local-node-bridge.js` separately.

Pick **one** mode — they configure the LSP differently and cannot coexist:

```bash
# from rgb-sdk-rn-demo root

# A. Single asset (default) — IFA `UTIF`, precision 6, virtual channels
./scripts/start-lsp-regtest.sh

# B. Two assets — the APay bridge-asset checkout, on-chain channels only
TWO_ASSETS=1 ./scripts/start-lsp-regtest.sh

# …either one, plus a VSS server on :8181
VSS=1 ./scripts/start-lsp-regtest.sh
```

> `LINKED_ASSET=1` still works as the old name of `TWO_ASSETS=1`.

What the script does, in both modes:

1. Starts the regtest docker stack if it is down, and `local-node-bridge` on `:5000`
2. Starts a fresh LSP RLN node (`:3005`, peer `:9737`) and Faucet RLN node
   (`:3008`, peer `:9740`), killing any previous ones and wiping their data dirs
3. Initializes, unlocks and funds both (1 BTC each), then creates 25 / 30 colorable UTXOs
4. Issues the RGB asset(s) **on the Faucet** and seeds the LSP — 6 separate
   `/sendrgb` rounds, each landing on its own LSP UTXO so several channels can be
   funded in parallel
5. Sets the `adb reverse` port forwards if an Android emulator is connected
6. Starts `utexo-lsp` (first run compiles Go deps — allow ~60 s)
7. Writes `.env.lsp.local`, `e2e-fixtures.json`, and the `EXPO_PUBLIC_LSP_REGTEST_*`
   block of `.env.local`

---

## The two modes

### A. Default — one asset, virtual channels

Issues IFA **`UTIF`** (precision 6) on the Faucet and seeds it to the LSP, which
serves it as its only `SUPPORTED_ASSET_IDS`.

The LSP node starts **with** `--enable-virtual-channels-v0` and
`DEFAULT_VIRTUAL_OPEN_MODE=trusted_no_broadcast`. Virtual channels are never
broadcast, so no dust limit applies and `MIN_AMT_MSAT` drops to **1 000 msat
(1 sat)** — that is what lets the IFA cart flow check out for 1 sat.

Runnable in the app: **APay Cart Checkout · IFA**.

### B. `TWO_ASSETS=1` — two assets, on-chain channels

Replaces the single `UTIF` issuance with **two ordinary IFA contracts, both
issued on the Faucet and unrelated to each other**:

| | ticker | role | utexo-lsp setting |
|---|---|---|---|
| payout | `LNUSDT` | what the merchant's channel and payout are in; seeded to the LSP | `SUPPORTED_ASSET_IDS` |
| bridge | `BUSDT` | what the buyer receives on-chain and funds its **own** channel with | `CONVERTIBLE_ASSET_IDS` |

There is **no RGB Asset Link** anywhere. What makes the two interchangeable is
`CONVERTIBLE_PAIRS`, and that list is the entire authorization for the 1:1 rate.
utexo-lsp quotes the buyer in `BUSDT`, pays the merchant `LNUSDT`, and converts
between the two legs of one APay payment — one shared payment hash keeps them
atomic.

The script also sets `CONVERTIBLE_ASSET_IDS`, `PAYOUT_ASSET_PREFERENCE`,
`CHANNEL_PROVISION_GRACE=30s` and `LIGHTNING_SEND_ENABLED=1` in this mode.

**No virtual channels at all here.** The LSP node starts **without**
`--enable-virtual-channels-v0` and `DEFAULT_VIRTUAL_OPEN_MODE` is empty, so
`MIN_AMT_MSAT` falls back to **3 000 000 msat (3 000 sat)** and every channel is
a real, confirmed on-chain one. The script only issues the assets — the buyer's
`BUSDT` channel is opened by the app itself.

Runnable in the app: **APay Bridge Asset**.

> ⚠️ **The two modes are mutually exclusive.** The other APay cart/IFA flows
> assume virtual channels and a 1-sat floor, so they will not work against a
> `TWO_ASSETS=1` stack. Switching modes means re-running the script — it wipes
> both node data dirs and re-issues everything from scratch.

### Channel sizing (both modes)

Deliberately mirrors `utexo-lsp/.env.signet`, so a regtest run exercises the
numbers the signet deployment actually uses:

```
CHANNEL_CAPACITY_SAT=75000        # LSP channel capacity
CHANNEL_PUSH_MSAT=12000000        # sats the peer can spend before receiving
CHANNEL_ASSET_AMOUNT=100000000    # 100.000000 units on the LSP's side
SEED_ROUNDS=6                     # separate /sendrgb rounds, 20 channels each
```

All overridable as env vars on the same command line.

---

## Expected final output

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  LSP regtest environment ready
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  utexo-lsp:   http://127.0.0.1:8080
  LSP daemon:  http://127.0.0.1:3005  (peer :9737)
  Faucet:      http://127.0.0.1:3008  (peer :9740)
  BRIDGE:      BUSDT (issuer=Faucet, the buyer spends it): rgb:...   ← TWO_ASSETS=1 only
  SERVING:     LNUSDT (IFA, precision 6): rgb:...
  Channel asset amount: 100000000 base units per channel
  MIN_AMT_MSAT:         3000000 msat (3000 sat)
  LSP pubkey:  02...
  Env file:    .../.env.lsp.local
  Fixtures:    .../e2e-fixtures.json
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

The `SERVING:` line names whichever asset is in `SUPPORTED_ASSET_IDS` — `UTIF`
by default, `LNUSDT` under `TWO_ASSETS=1`. `BRIDGE:` only appears in the
two-asset mode.

---

## Step 4 — Android emulator port forwards (Android only)

If the script did not detect a connected device, set these manually **before
starting the app**:

```bash
adb reverse tcp:3000 tcp:3000   # RGB Proxy  ← most critical
adb reverse tcp:3005 tcp:3005   # LSP RLN node
adb reverse tcp:3008 tcp:3008   # Faucet RLN node
adb reverse tcp:8080 tcp:8080   # utexo-lsp
adb reverse tcp:5000 tcp:5000   # local-node-bridge
adb reverse tcp:8081 tcp:8081   # Metro JS
adb reverse tcp:8082 tcp:8082   # Metro HMR
```

> The proxy forward (`tcp:3000`) must be set **before** `utexo-lsp` starts. The
> LSP cron fires every 5 s and tries to open RGB channels for every connected
> peer; if the proxy is unreachable from the emulator each attempt locks a UTXO
> and never settles. Enough failures and `spendable=0` → `InsufficientAssets`.
> Re-run the setup script to recover.

The faucet forward (`tcp:3008`) matters for the two-asset flow specifically —
the app calls the Faucet directly to send itself `BUSDT` and to pay the
merchant's top-up.

---

## Step 5 — Build and run the demo app

```bash
npm install --install-strategy=nested
npm run prebuild

# iOS
cd ios && LANG=en_US.UTF-8 pod install && cd ..
npm run ios:release

# Android
npm run android:release
```

Use **Release** builds, or Debug with `npm run ios:relaunch` /
`npm run android:relaunch` after every JS change and Fast Refresh turned off — a
JS reload orphans the native RLN nodes (ports stay bound, no JS handle left).
See the build note in `CLAUDE.md`.

In the app: **LSP tab → Regtest**. The Bridge Asset flow is first in the list;
the IFA cart flow is further down.

---

## Stopping everything

```bash
./scripts/start-lsp-regtest.sh stop        # kills LSP, Faucet, utexo-lsp, bridge
pkill -f "utexo-lsp"                        # stop misses compiled binaries
cd rgb-lightning-node && ./regtest.sh stop  # wipes docker stack
```

---

## Troubleshooting

**`InsufficientAssets` or stuck Initiated Sends**
Set all `adb reverse` ports, then re-run `./scripts/start-lsp-regtest.sh`.

**`CounterpartyForceClosed: Failed to find RGB consignment`**
Same cause — `adb reverse tcp:3000 tcp:3000` was missing before utexo-lsp started.

**A flow polls forever waiting for a channel**
Usually the wrong mode. The IFA cart flow needs the default stack; the Bridge
Asset flow needs `TWO_ASSETS=1`. Check the `SERVING:` line in the script output
against what the flow expects.

If LSP shows `Opening` with no funding transaction while the app shows zero
channels, inspect both nodes' `.ldk/logs/logs.txt`. An app-side
`unknown required feature flag or TLV` immediately after LSP sends `OpenChannel`
indicates a protocol mismatch. A July daemon sent the old `consignment_endpoint`
TLV, which the September iOS framework rejected. Rebuild the daemon from a
compatible checkout and rerun setup after stopping the app flow.

**Bridge Asset flow: `discovery advertises no payout asset`, or a refund arrives unconverted**
`CONVERTIBLE_ASSET_IDS` / `CONVERTIBLE_PAIRS` / `PAYOUT_ASSET_PREFERENCE` are
not set — i.e. the stack was started without `TWO_ASSETS=1`.

**A 1-sat payment is rejected**
`MIN_AMT_MSAT` is 3 000 000 on a `TWO_ASSETS=1` stack, because regular channels
carry a per-HTLC dust floor. Only the default (virtual) stack allows 1 sat.

**`RLN executable not found`**
Build the daemon once using the command in Step 1. Setup never builds it
automatically. If `--locked` rejects the lockfile, reconcile it with that
checkout's dependencies first.

**utexo-lsp takes >60 s to start**
Normal on first run while Go downloads and compiles dependencies.

---

## Logs

All daemon logs are written to `logs/` inside this repo (created automatically):

```
logs/bridge.log       # local-node-bridge
logs/rln-lsp.log      # LSP RLN node
logs/rln-faucet.log   # Faucet RLN node
logs/utexo-lsp.log    # utexo-lsp Go service
```
