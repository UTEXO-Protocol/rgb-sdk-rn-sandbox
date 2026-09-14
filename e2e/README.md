# rgb-sdk-rn e2e suite

Behaviour-against-a-real-node tests for the **rn** track (MIGRATION-PLAN-v3
§7a, step 6b.3). The unit suite and `check:contract` verify *shape*; this suite
verifies *values* coming back from a live regtest stack, field by field — and
it is the only place `rlnInflate` is ever executed rather than merely compiled.

## Running

```bash
# 1. Bring up the regtest stack (docker + 2 RLN daemons + utexo-lsp + bridge).
#    Writes e2e-fixtures.json — the suite's input.
export RGBLN_REPO=…/rgb-lightning-node UTEXO_LSP_REPO=…/utexo-lsp
./scripts/start-lsp-regtest.sh

# 2. Emulator with the demo installed (once per code change).
emulator -avd Medium_Phone_API_36.1 &
yarn android

# 3. Run the suite.
yarn test:e2e                 # all scenarios
yarn test:e2e --only A,D      # subset
yarn test:e2e --verbose       # echo raw ReactNativeJS logs too
```

Exit code: `0` pass, `1` a scenario failed, `2` setup/timeout problem.

## VSS restore on the iOS simulator (scenario H)

```bash
export RGBLN_REPO=/Users/yuriibandrivskyi/Desktop/utexo/rgb-lightning-node
export UTEXO_LSP_REPO=/Users/yuriibandrivskyi/Desktop/utexo/utexo-lsp
VSS=1 ./scripts/start-lsp-regtest.sh
# Start/build the iOS demo and leave Metro running:
npm run ios
# In another terminal, run H on the booted simulator:
npm run test:e2e -- --platform ios --only H
# With multiple booted simulators, append --device <simulator-UDID>.
```

Setup recreates local LSP/Faucet wallets and the utexo-lsp database; when
regtest is stopped it starts a fresh chain. VSS uses `http://127.0.0.1:8181/vss`
so it does not conflict with Metro on 8081. The runner reads `VSS_URL` from
`e2e-fixtures.json`; it does not use the public UTEXO VSS endpoint. The iOS
runner restarts the app before opening the e2e deep link to release old native
nodes. Its marker sink is on `127.0.0.1:8099`.

H funds a fresh wallet, issues an NIA asset, opens a channel to the Faucet,
receives a Lightning payment, calls `backupNow()`, shuts down and wipes the
wallet, restores with the same mnemonic, checks state, reconnects the channel,
and closes it to verify that funds return on-chain.

## How it works

The SDK cannot run headless in Node here — the wallet talks to a TurboModule,
so native calls only happen on a device (§7a.4). So the suite runs *inside* the
demo app and the host only judges it:

| Piece | Role |
|---|---|
| `app/e2e.tsx` | flow-runner screen, outside the tabs, opened by deep link |
| `e2e/run.ts` | orchestrator — one wallet, scenarios A–E in order, then teardown |
| `e2e/harness.ts` | boot, fixtures, `waitFor`, `step()` |
| `e2e/scenarios/*` | the scenarios themselves, assertions only |
| `e2e/marker.ts` | one JSON marker per step, POSTed to the host sink |
| `scripts/run-e2e-android.mjs` | serves the sink, launches the deep link, sets the exit code |

**Markers travel over HTTP, not `adb logcat`.** §6.0m planned to scrape
`[[E2E]]` lines out of logcat; that was tried and does not work — under the New
Architecture `console.log` is delivered to the Metro dev server, and only RN's
own startup line reaches the `ReactNativeJS` tag. The runner therefore serves a
one-route sink on `:8099` (`--port` to change) which the app POSTs to at
`10.0.2.2:8099`. Nothing depends on the `console.log`, which is still emitted
for whoever is watching Metro.

Assertions come from `@utexo/rgb-sdk-core/conformance` (`expectFields`,
`expectEach`, `expectNoWireKeys`, the canonical status vocabularies) — the same
helpers the web suite uses, so the two tracks cannot drift in what counts as a
valid response.

## Scenarios

| # | Covers |
|---|---|
| A | node/network info, `capabilities` vs. the live carriers, `runConformanceChecks` against the **live** wallet (closes the §6.0f gap for rn) |
| B | address → fund via bridge → balance increase → `createUtxos` → `listUnspents` with parsed outpoints |
| C | `issueAssetNia` → `listAssets` → balance → `blindReceive` → `decodeRGBInvoice` → `listTransfers` |
| D | **`issueAssetIfa` → `inflate` → balance rises by exactly the inflation amount** — the proof step 1b was missing |
| E | `connectPeer`(Faucet) → `openChannel` → ready → `createLightningInvoice` → Faucet pays → `Succeeded` |

Scenario F (carriers) is web-only by construction: rn has none of the three.

## Constraints worth knowing

- **Fixtures travel in the deep link**, not in `EXPO_PUBLIC_*`. Env vars are
  inlined into the bundle at build time, so a re-provisioned stack would
  otherwise need a rebuild before the suite could see the new asset id.
- **URLs are rewritten to `10.0.2.2`** in-app (`hostUrl`/`hostAddr`), matching
  what `utils/bitcoin-node.ts` already does. No `adb reverse` is needed for the
  peer ports (9737/9740) or the Faucet REST port (3008).
- **The rn stack and the web stack cannot run at the same time** — both claim
  :3000, :18443, :50001 (§6.0l). Stop one before starting the other.
- **Core must be rebuilt** for changes to the field helpers to reach the app:
  metro resolves `dist/`, not `src/` (`cd ../rgb-sdk-core && npm run build`).
- One wallet is shared across A–E: B's colorable UTXOs and C's asset are inputs
  to the later scenarios. `dispose()` is asserted once, in teardown.
- Local gate, not CI: `start-lsp-regtest.sh` hard-requires local repo paths
  (§7a.6).

## Comparing the demo VSS flows

Use **VSS Backup & Restore** in Regtest and UTEXO. Both create two wallets,
fund node A with 1,227,500 sats, create 3 × 32,500-sat RGB UTXOs, issue 500 VDMO,
open a 100,000-sat channel with zero push, back up, wipe, and restore with the
same mnemonic. Both verify identity, channel ID/capacity and asset balance.
Regtest uses the local Bitcoin bridge and mining instead of the public faucet
and naturally arriving confirmations. Scenario H remains a separate e2e test.

For iOS, compare these configurations (restart Metro/app after env changes):

| Wallet network | VSS variable | Endpoint |
| --- | --- | --- |
| Regtest | `EXPO_PUBLIC_RLN_VSS_URL` | `http://127.0.0.1:8181/vss` |
| Regtest | `EXPO_PUBLIC_RLN_VSS_URL` | `https://vss-server.utexo.com/vss` |
| UTEXO | `EXPO_PUBLIC_UTEXO_VSS_URL` | `http://127.0.0.1:8181/vss` |
| UTEXO | `EXPO_PUBLIC_UTEXO_VSS_URL` | `https://vss-server.utexo.com/vss` |

Change one factor at a time. A local pass plus a remote failure on the same
regtest flow points to the remote VSS path/deployment, not proof of a specific
DB fault. Compare the exact failing operation, not just the final PASS/FAIL.

### Temporary UTEXO `backupNow()` diagnostic

Set `EXPO_PUBLIC_UTEXO_VSS_BACKUP_ONLY=1` in `.env.local`, restart Metro and
the iOS app, then run **VSS Init & Backup** in the **UTEXO** tab.
It runs `init → unlock → backupNow` on one fresh UTEXO wallet, using
`EXPO_PUBLIC_UTEXO_VSS_URL` for every VSS operation. It stops after backup;
there is no funding, channel creation, wipe or restore.

An unlock failure stops the test before `backupNow`; it must not be ignored.
Set the flag to `0` and restart Metro/app to restore the full flow.
Regtest is unaffected. No native rebuild is needed.
