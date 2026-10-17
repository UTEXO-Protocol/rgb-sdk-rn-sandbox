# rgb-sdk-rn#58 — `unlock()` hangs after VSS restore of a channel with a claimed payment

Investigation notes, 2026-10-16.

**TL;DR** — The reporter's exact path was reproduced twice, on local regtest and
on the reporter's own signet infrastructure. Restore completed both times (4 s
and 21 s). The last LDK lines quoted in the issue appear in our logs too, but
they are the normal startup claim replay, not a deadlock: the channel is
released about a second later. The reporter's node gets stuck somewhere else,
before LDK reaches `Loaded existing ChannelMonitor`. We need data from their
devices to see where — see [What to ask the reporter](#what-to-ask-the-reporter).

## The report

- Versions: rgb-sdk-rn 1.0.0-beta.32 → beta.37, rgb-sdk-core beta.9,
  RLN 0.13.0-beta.3 → 0.16.0-beta.3. Network: signet, LSP `lsp-signet.utexo.com`,
  VSS `https://vss-server.utexo.com/vss`. Platforms: iOS and Android, dev and release.
- Steps: init + unlock with `vssUrl` → receive LNUSDT via `receiveAsset` (the LSP
  opens the channel) → `PaymentClaimed` → `backupNow()` → delete the app →
  import the mnemonic → `init` → `vssClearFence` → `unlock`
  (`vssAllowEmptyRestore: false`). `unlock` never returns.
- According to the reporter, the hang requires a **claimed** payment in the
  backup. Without one, restore works.
- The reporter's log ends with:

  ```
  Successfully loaded channel … at update_id 5 against monitor at update id 5
  Completing monitor update completion action … as claim was redundant: PaymentClaimed { … pending_mpp_claim … }
  Delaying monitor unlock for channel … as another channel's mon update needs to complete first
  ```

  The reporter reads this as an LDK MPP claim-replay deadlock.

## Reproduction

Both scenarios follow the reporter's path step by step. An LSP-opened
**regular** (non-virtual) channel receives an RGB asset through
`lightning_receive`, the payment is claimed, then `backupNow` → shutdown →
delete the storage dir → restore with the same mnemonic (`init → vssClearFence
→ unlock`, `vssAllowEmptyRestore: false`). A 180 s / 15 min deadline makes a
hang fail the scenario by name. After restore the scenario checks the pubkey,
the channel capacity, the local balance and `assetLocalAmount`.

| | Scenario I (regtest) | Scenario J (signet) |
|---|---|---|
| file | `e2e/scenarios/i-restore-claimed-rgb.ts` | `e2e/scenarios/j-restore-claimed-rgb-signet.ts` |
| LSP | local utexo-lsp, `VIRTUAL_OPEN_MODE=` | `lsp-signet.utexo.com` (`virtual_channel_mode` empty) |
| VSS | local vss-server `:8181` | `https://vss-server.utexo.com/vss` |
| indexer | local electrs | `https://esplora-api.utexo.com` |
| asset | IFA UTIF, same asset on-chain and in the channel | LNUSDT over LN, paid on-chain in USDT (converted `lightning_receive`) |
| app | rgb-sdk-rn 1.0.0-beta.39, native RLN 0.17.0-beta.3, iOS simulator (Debug) | same |
| LSP / faucet RLN | 0.16.0-beta.3 | deployed signet nodes |
| channel | `9366aed4…4195`, 75 000 sat | `c6acf679…5531`, 75 000 sat |
| claimed payment | 1.0 UTIF (1 000 000 base units) | 1.0 LNUSDT (1 000 000 base units) |
| backup version | 5 | — |
| **restore duration** | **3.96 s** | **20.9 s** |
| result | PASS (50 s total) | PASS (554 s total) |

How to run:

```bash
# I — regtest
VIRTUAL_OPEN_MODE= VSS=1 ./scripts/start-lsp-regtest.sh
npm run test:e2e -- --platform ios --only I

# J — signet (EXPO_PUBLIC_UTEXO_* and EXPO_PUBLIC_FAUCET_NODE_URL must be set;
# the faucet node must hold BTC and USDT)
npm run test:e2e -- --platform ios --only J --idle-timeout 1800 --timeout 5400
```

iOS runner workarounds (not fixed yet):

- The dev client loads Metro from port **8082**.
- `--platform ios` without `--no-launch` relaunches the app into the dev
  launcher, where the deep link is lost. Instead, load the bundle with
  `xcrun simctl openurl booted "myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082"`,
  start the runner with `--no-launch`, and send the `myapp://e2e?…&only=J`
  link by hand.
- Metro started with `CI=1` does not watch files. Restart it after code changes.

## What the logs show

Restored node, `<storageDir>/.ldk/logs/logs.txt`.

**Regtest (I):**

```
08:27:30.2xx  Successfully loaded channel 9366… at update_id 5 against monitor at update id 5   [channelmanager:17312]
08:27:30.2xx  Completing monitor update completion action … as claim was redundant: PaymentClaimed { … }   [channelmanager:9340]
08:27:30.263  Delaying monitor unlock for channel 9366… as another channel's mon update needs to complete first   [channelmanager:13986]
08:27:31.046  Loaded existing ChannelMonitor for channel 9366…
08:27:31.069  transaction sync … 1 confirmed
08:27:31.071  Handling event PaymentClaimed { … } → Done handling event, result: Ok(())
08:27:31.071  Unlocked monitor updating for channel 9366… without monitors to update
```

**Signet (J):**

```
10:29:07.174  Successfully loaded channel c6acf679… at update_id 3 against monitor at update id 3 with 0 blocked updates
10:29:07.176  Completing monitor update completion action … as claim was redundant: PaymentClaimed { … }
10:29:07.176  Delaying monitor unlock for channel c6acf679… as another channel's mon update needs to complete first
10:29:12.345  Loaded existing ChannelMonitor for channel c6acf679…
10:29:13.698  Handling event PaymentClaimed { … }
10:29:13.699  Done handling event, result: Ok(())
10:29:13.699  Unlocked monitor updating for channel c6acf679… without monitors to update
```

These are the same three lines and the same LDK source lines as in the issue.
In both of our runs, LDK continues after "Delaying" and releases the channel.

### Why "Delaying monitor unlock" is expected

LDK (vendored in `rgb-lightning-node/rust-lightning`) behaves differently when a
claim happens live and when it is replayed:

- **Live claim:** `PendingMPPClaim` is created only when the payment has more
  than one source (`sources.len() > 1`, `channelmanager.rs` ~9086).
- **Startup replay:** for claims stored in the monitor, `PendingMPPClaim` is
  **always** built (`channelmanager.rs` ~18587). So the
  `pending_mpp_claim` / `channels_without_preimage` fields show up even for a
  single-part payment.
- The channel's monitor updating stays held until the node's event handler
  processes the replayed `PaymentClaimed`. Then `ReleaseRAAChannelMonitorUpdate`
  (`channelmanager.rs` ~11833) produces "Unlocked monitor updating".

The event handler (`Event::PaymentClaimed`, RLN `src/ldk.rs` ~2954) runs only
once `start_lightning` has reached `process_events_async` (~6577). So
"Delaying" will always be printed first and stay unresolved for a while. How
long depends on how quickly `start_lightning` gets there: 0.8 s on regtest, 5 s
on signet.

### Where the reporter's node is actually stuck

Their log stops right after "Delaying" and never shows
`Loaded existing ChannelMonitor`, which is printed when the monitors are handed
to the ChainMonitor. The hang is therefore in RLN `start_lightning`
(`src/ldk.rs`), between reading the ChannelManager (~5826) and the ChainMonitor
`watch_channel` calls. Code in that window:

1. `create_common_state` (~4936): rgb-lib wallet init, including the **RGB
   wallet restore from VSS** (the `<pubkey>_rgb` store, ~4486) and the blocking
   VSS auto-backup setup (~5080).
2. `reimport_funding_consignments` (~4685, called at ~5921).
3. `synchronize_listeners` / chain sync against the indexer (~6027).

In our runs this window grows from 0.8 s on regtest to 5 s on signet, because
it does network I/O (remote VSS and esplora). For the reporter it does not
finish within 45+ minutes.

### Logging gap in the embedded SDK

Only the daemon binary installs a `tracing` subscriber (`src/main.rs` ~113–130,
`rln.log`). The embedded SDK/uniffi build installs none, so every
`tracing::info!` in `start_lightning` is dropped on device. That includes
"Restored RGB wallet from VSS", "re-imported funding consignment" and the VSS
store messages. Only the LDK logger (`.ldk/logs/logs.txt`) reaches disk.
Without a stack dump there is no way to tell which of the three steps above
is hanging.

**Follow-up on our side:** install a `tracing` subscriber in the SDK build
(os_log on iOS, logcat on Android, or the same `rln.log` file in the storage
dir).

## What to ask the reporter

In order of usefulness:

1. **Thread backtraces of the hung process**, two samples about 30 s apart
   (to tell a deadlock from a slow loop):
   - iOS simulator: `sample <pid> 10 -file hang.txt` on the Mac
     (`pgrep -f <AppName>` gives the pid).
   - iOS device: Xcode → Pause → `thread backtrace all` in lldb.
   - Android: `adb shell debuggerd -b $(adb shell pidof <package>) > hang.txt`
     (debuggable build or emulator).
2. **The full `<storageDir>/.ldk/logs/logs.txt`** of the restored node,
   timestamped, from `unlock` until the app was killed. Not just the last three
   lines. On Android:
   `adb exec-out run-as <package> cat files/<dir>/.ldk/logs/logs.txt`.
3. **A file listing of the storage dir after the hang**
   (`find <storageDir> -type f -exec ls -la {} \;`). This shows whether the RGB
   wallet was restored from VSS and whether monitors and consignments were
   written. Without tracing logs it is the only signal we have for this.
4. **Exact configuration:**
   - rgb-sdk-rn / rgb-sdk-core / RLN versions; Debug or Release; device or simulator.
   - `unlock` params (secrets may be masked): `indexerUrl` (electrum or esplora,
     which host), `proxyEndpoint`, `vssUrl`, `vssAllowEmptyRestore`.
   - Whether `vssClearFence()` returned, and how long it took.
   - The `backupNow()` result / backup version before the wipe.
   - Time between the claim and `backupNow()`, and whether the channel funding
     tx was confirmed at backup time.
5. **A retest on rgb-sdk-rn 1.0.0-beta.39** (RLN 0.17.0-beta.3). Both of our
   reproductions pass on it, on regtest and on signet.

### Draft comment for the issue

> We reproduced your path on rgb-sdk-rn beta.39 / RLN 0.17.0-beta.3, both on
> regtest and on signet against `lsp-signet.utexo.com` + `vss-server.utexo.com`:
> an LSP-opened regular channel, LNUSDT claimed via `lightning_receive`, then
> `backupNow` → wipe → init / vssClearFence / unlock. Restore completes in 4 s
> (regtest) and 21 s (signet). Our restored LDK logs contain **the same three
> lines** you posted (`claim was redundant: PaymentClaimed{…pending_mpp_claim…}`,
> `Delaying monitor unlock…`). That line is the normal startup claim replay: the
> channel is released once the node's event handler processes the replayed
> `PaymentClaimed`, about 1–6 s later (`Loaded existing ChannelMonitor` →
> `Handling event PaymentClaimed` → `Unlocked monitor updating for channel…`).
> So this does not look like an LDK MPP deadlock. Your node stalls *before* it
> hands the monitors to the chain monitor, i.e. during RGB wallet init / VSS RGB
> restore, funding-consignment reimport, or indexer sync.
>
> Could you please attach:
> 1. **Thread backtraces of the hung app**, two samples about 30 s apart
>    (iOS sim: `sample <pid> 10`; iOS device: Xcode Pause → `thread backtrace all`;
>    Android: `adb shell debuggerd -b <pid>`).
> 2. The **full** `<storageDir>/.ldk/logs/logs.txt` of the restored node, from
>    unlock until the kill.
> 3. A file listing of `<storageDir>` after the hang.
> 4. Exact versions and unlock params (indexer URL/type, proxy, VSS URL,
>    `vssAllowEmptyRestore`), and whether `vssClearFence()` returned.
> 5. If possible, a retest on beta.39.

## Related

- rgb-sdk-rn#62 (same seed on two devices, VSS backups overwrite each other) is
  a **different** bug, in rgb-lib `src/wallet/vss.rs`: no real CAS, and the
  `_rgb` store has no fence. It was not investigated here.
