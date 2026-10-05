#!/usr/bin/env bash
# start-lsp-regtest.sh
#
# Sets up the full LSP regtest environment matching the utexo-lsp e2e test fixture:
#   LSP daemon  (port 3005, peer 9737) — native RLN binary
#   Faucet daemon (port 3008, peer 9740) — native RLN binary
#   utexo-lsp   (port 8080) — Go service
#   local-node-bridge (port 5000) — bitcoin-cli helper for mine/send
#
# Run once before starting the demo app.
# Outputs .env.lsp.local with LSP_ASSET_ID, LSP_PEER_PUBKEY, etc.
#
# One RGB asset is issued on the faucet:
#   IFA "UTIF" precision 6 — fractional units, used by the APay IFA cart flow
#
# The regtest docker services (bitcoind, electrs, proxy) are started here if
# they are not already up — no separate `./regtest.sh start` needed.
#
# Usage:
#   ./scripts/start-lsp-regtest.sh          # serve UTIF (IFA, precision 6)
#   VSS=1 ./scripts/start-lsp-regtest.sh    # …plus vss-server on :8181 (NOT
#                                           # :8081 — Metro owns that port);
#                                           # adds VSS_URL to e2e-fixtures.json
#   TWO_ASSETS=1 ./scripts/start-lsp-regtest.sh
#                                           # issue TWO assets instead of a single
#                                           # UTIF, for the APay bridge-asset
#                                           # checkout. Both are ordinary IFA
#                                           # contracts on the Faucet, unrelated to
#                                           # each other:
#                                           #   LNUSDT — what the merchant is paid
#                                           #            out in; the only
#                                           #            SUPPORTED_ASSET_ID, seeded
#                                           #            to the LSP from the Faucet
#                                           #   BUSDT  — what the buyer holds and
#                                           #            spends; CONVERTIBLE only,
#                                           #            the cron never opens it
#                                           # utexo-lsp quotes the buyer in BUSDT and
#                                           # pays the merchant in LNUSDT, converting
#                                           # 1:1 between the two legs of one APay
#                                           # payment — option A of
#                                           # docs/apay-linked-asset-options.uk.md,
#                                           # as revised in its §10. There is no RGB
#                                           # Asset Link anywhere: CONVERTIBLE_PAIRS
#                                           # is what authorizes the conversion.
#                                           # No virtual channels anywhere in this
#                                           # mode: LSP starts WITHOUT
#                                           # --enable-virtual-channels-v0, and its
#                                           # cron opens the merchant's LNUSDT leg as
#                                           # a regular on-chain channel
#                                           # (DEFAULT_VIRTUAL_OPEN_MODE unset). The
#                                           # buyer's BUSDT channel is opened by the
#                                           # client itself — the app is responsible
#                                           # for that, this script only issues the
#                                           # assets and exposes BRIDGE_ASSET_ID.
#                                           # LINKED_ASSET=1 still works as the old
#                                           # name of this flag.
#   ./scripts/start-lsp-regtest.sh stop     # kill daemons (docker stays up)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RGBLN_REPO="${RGBLN_REPO:?Set RGBLN_REPO to your rgb-lightning-node path, e.g.: export RGBLN_REPO=~/rgb/rgb-lightning-node}"
UTEXO_LSP_REPO="${UTEXO_LSP_REPO:?Set UTEXO_LSP_REPO to your utexo-lsp path, e.g.: export UTEXO_LSP_REPO=~/rgb/utexo-lsp}"
RLN_BIN="$RGBLN_REPO/target/release/rgb-lightning-node"

LSP_DIR="$RGBLN_REPO/data_lsp"
FAUCET_DIR="$RGBLN_REPO/data_faucet"

LSP_PORT=3005
LSP_PEER_PORT=9737
FAUCET_PORT=3008
FAUCET_PEER_PORT=9740
UTEXO_PORT=8080
BRIDGE_PORT=5000
# vss-server (root compose, --profile vss; VSS=1 opt-in). NOT :8081 as in the
# web stack — Metro owns that port here, so the container is republished on
# 8181 via scripts/compose.vss-rn.yaml.
VSS_PORT="${VSS_PORT:-8181}"
VSS_URL="http://127.0.0.1:$VSS_PORT/vss"
VSS_OVERRIDE="$SCRIPT_DIR/compose.vss-rn.yaml"

PASSWORD="password123"
BTC_USER="user"
BTC_PASS="password"
BTC_HOST="127.0.0.1"
BTC_PORT=18443
INDEXER_URL="127.0.0.1:50001"
PROXY_ENDPOINT="rpc://127.0.0.1:3000/json-rpc"

# LDK sync mode is mandatory in the current REST API. RPC credentials belong
# inside its config; indexer_url below independently configures the RGB wallet.
UNLOCK_BODY="{\"password\":\"$PASSWORD\",\"ldk_chain_sync\":{\"mode\":\"BlockSync\",\"config\":{\"bitcoind_rpc_username\":\"$BTC_USER\",\"bitcoind_rpc_password\":\"$BTC_PASS\",\"bitcoind_rpc_host\":\"$BTC_HOST\",\"bitcoind_rpc_port\":$BTC_PORT}},\"indexer_url\":\"$INDEXER_URL\",\"proxy_endpoint\":\"$PROXY_ENDPOINT\",\"announce_addresses\":[]}"

ENV_OUT="$DEMO_DIR/.env.lsp.local"

# ── demo asset ────────────────────────────────────────────────────────────────
# Every amount below is in *base units* (10^-precision), the only unit the RGB
# and LSP APIs speak. 1.000000 UTIF is therefore 1000000.
IFA_TICKER="${IFA_TICKER:-UTIF}"
IFA_NAME="${IFA_NAME:-UTEXO LSP Inflatable}"
IFA_PRECISION="${IFA_PRECISION:-6}"

# ── two-asset checkout (opt-in) ─────────────────────────────────────────────
# TWO_ASSETS=1 replaces the single UTIF issuance with two assets, for the APay
# bridge-asset checkout (option A of docs/apay-linked-asset-options.uk.md — the
# LSP converts 1:1 between the two legs of one APay payment):
#
#   LNUSDT — issued on the Faucet, seeded to the LSP, what the MERCHANT is paid
#            out in and what utexo-lsp serves (SUPPORTED_ASSET_IDS)
#   BUSDT  — issued on the Faucet, what the BUYER holds and spends
#            (CONVERTIBLE_ASSET_IDS — accepted and paid out, never provisioned)
#
# Both are plain IFA contracts with no relationship to each other. The pair used
# to be an RGB Asset Link, which forced the LSP to issue LNUSDT itself: the proof
# (parent.linked_to_asset_id + a settled Link transfer) lives only in the wallet
# that ran link_ifa and never travels in a consignment, measured in
# docs/linked-asset-bridge-test-report.md §5.2. utexo-lsp no longer looks for it —
# CONVERTIBLE_PAIRS is the entire authorization. See §10 of
# docs/apay-linked-asset-options.uk.md.
TWO_ASSETS="${TWO_ASSETS:-${LINKED_ASSET:-0}}"   # LINKED_ASSET=1: old name
LN_IFA_TICKER="${LN_IFA_TICKER:-LNUSDT}"
LN_IFA_NAME="${LN_IFA_NAME:-LnUSDT}"
BRIDGE_IFA_TICKER="${BRIDGE_IFA_TICKER:-BUSDT}"
BRIDGE_IFA_NAME="${BRIDGE_IFA_NAME:-bridgeUSDT}"
# Dust-sized send that teaches the LSP a contract it did not issue and is never
# seeded: without it /assetmetadata for BUSDT 403s with UnknownContractId, and
# discovery cannot advertise the asset's ticker/precision before the buyer's own
# channel exists.
BRIDGE_BOOTSTRAP_UNITS="${BRIDGE_BOOTSTRAP_UNITS:-${LINK_BOOTSTRAP_UNITS:-1}}"

# ── channel / amount policy ──────────────────────────────────────────────────
#
# Sized to mirror the signet deployment (utexo-lsp/.env.signet), so a regtest run
# exercises the numbers production will actually use. The three values below are
# one decision, not three — see CHANNEL_ASSET_AMOUNT for the arithmetic.
#
# Capacity is driven by sats, not by the asset: every delivery to a peer also
# moves >= MIN_AMT_MSAT of sats to its side, and they only come back if the peer
# spends. So capacity buys PAYMENTS, at a flat 3 000 sat each:
#
#   deliveries = (capacity - push_sat) / (MIN_AMT_MSAT / 1000)
#              = (75 000 - 12 000) / 3 000 = 21
#
# 75 000 is chosen to be affordable on mainnet, where these sats are locked per
# peer. It cannot go much lower: rgb-lightning-node refuses an RGB channel below
# htlc_min_msat/1000 * 10 + 10 = 30 010 sat (ChannelsSection::open_rgb_min_sat,
# src/config/mod.rs) — "at least ten minimum HTLCs". 75 000 is 2.5x that floor.
CHANNEL_CAPACITY_SAT="${CHANNEL_CAPACITY_SAT:-75000}"

# What the peer can SPEND before it has received anything. LDK locks 1% of
# capacity as the peer's channel reserve (their_channel_reserve_proportional_
# millionths = 10_000, rust-lightning util/config.rs; RLN only overrides it to 0
# for virtual opens), so 750 sat here is untouchable and 12 000 - 750 leaves 3
# payments at the floor — the cart flow's refund, relay and recipient legs, each
# of which is anyway preceded by a receive. The old 5 000 000 left exactly ONE.
#
# In production this can go lower still: a peer that only ever receives needs no
# push at all. It is the merchant paying OUT that costs you this.
CHANNEL_PUSH_MSAT="${CHANNEL_PUSH_MSAT:-12000000}"
# TWO_ASSETS=1 is on-chain-only end to end (see docs/apay-linked-asset-mvp.md):
# the LSP's cron opens the merchant's payout leg as a regular channel, not virtual.
_DEFAULT_VIRTUAL_OPEN_MODE="trusted_no_broadcast"
[ "$TWO_ASSETS" = "1" ] && _DEFAULT_VIRTUAL_OPEN_MODE=""
VIRTUAL_OPEN_MODE="${VIRTUAL_OPEN_MODE-$_DEFAULT_VIRTUAL_OPEN_MODE}"

# RGB units the LSP puts on its side of each channel it opens: 100000000 base
# units = 100.000000 at precision 6. It caps what one payment may carry — see
# validateDeliverableAmounts in utexo-lsp.
#
# Match it to the sats, not the other way round. A payment costs a flat 3 000 sat
# however much asset it carries, so the channel's 21 deliveries want
#
#   asset_per_channel = 21 x typical_payment
#
# and 100 units divides into 20 payments of 5 units. That is what fixes the cart
# flow's checkout at 5 units rather than 0.5: at 0.5 the 3 000 sat floor is 6x
# the value being moved, and matching 100 units would have needed a 640 000 sat
# channel per peer — unaffordable on mainnet. The floor is also why sub-dollar
# RGB payments do not make economic sense on a regular (broadcastable) channel;
# only trusted_no_broadcast channels drop it to 1 sat, and this mode has none.
CHANNEL_ASSET_AMOUNT="${CHANNEL_ASSET_AMOUNT:-100000000}"

# Seeding: SEED_ROUNDS separate sends per asset, each landing on its own LSP
# UTXO, so several channels can be funded in parallel. 20 channels' worth per
# round keeps the LSP from hitting InsufficientAssets mid-demo.
#
# Both derive from CHANNEL_ASSET_AMOUNT, so they followed it up ×100: 2e9 base
# units per round, 2.4e10 issued (24 000 units, ~120 channels' worth). Large but
# free — this is regtest, and an IFA `amounts` entry is a u64.
SEED_ROUNDS="${SEED_ROUNDS:-6}"
SEED_UNITS="${SEED_UNITS:-$((CHANNEL_ASSET_AMOUNT * 20))}"
ISSUE_AMOUNT="${ISSUE_AMOUNT:-$((SEED_UNITS * SEED_ROUNDS * 2))}"

# Per-payment floor advertised by utexo-lsp. rgb-lightning-node negotiates
# VIRTUAL_HTLC_MIN_MSAT (1000 msat = 1 sat) on virtual channels and
# HTLC_MIN_MSAT (3000000 msat) on regular ones — an RGB payment rides the HTLC
# output, and a dust-trimmed HTLC on a broadcastable commitment cannot settle
# it. A trusted_no_broadcast channel is never broadcast, so 1 sat is safe there
# and the floor follows VIRTUAL_OPEN_MODE.
if [ -n "$VIRTUAL_OPEN_MODE" ]; then
  MIN_AMT_MSAT="${MIN_AMT_MSAT:-1000}"
else
  MIN_AMT_MSAT="${MIN_AMT_MSAT:-3000000}"
fi
# minSendable is what the SDK validates payAddress against, so it has to track
# MIN_AMT_MSAT or the LSP would advertise a floor it does not enforce.
LN_ADDR_MIN_SENDABLE_MSAT="${LN_ADDR_MIN_SENDABLE_MSAT:-$MIN_AMT_MSAT}"
# …and maxSendable to the per-HTLC ceiling utexo-lsp derives from capacity ×
# PEER_MAX_INBOUND_HTLC_IN_FLIGHT_PERCENT (10), so discovery cannot promise more
# than a fresh channel could carry.
LN_ADDR_MAX_SENDABLE_MSAT="${LN_ADDR_MAX_SENDABLE_MSAT:-$((CHANNEL_CAPACITY_SAT * 1000 * 10 / 100))}"

# Colored-UTXO budget. Each blinded receive burns one UTXO on the LSP and each
# send needs change on the faucet; with SEED_ROUNDS rounds the stock 10 would
# run out before seeding finishes.
LSP_UTXO_NUM="${LSP_UTXO_NUM:-25}"
FAUCET_UTXO_NUM="${FAUCET_UTXO_NUM:-30}"

# ── helpers ───────────────────────────────────────────────────────────────────

log() { echo "[lsp-setup] $*"; }
die() { echo "[lsp-setup] ERROR: $*" >&2; exit 1; }

rln_post() {
  local port=$1 path=$2 body=${3:-'{}'} resp
  resp=$(curl -s -w "\n%{http_code}" -X POST "http://127.0.0.1:$port$path" \
    -H 'Content-Type: application/json' -d "$body") || die "POST $path failed on port $port (curl error)"
  local code=${resp##*$'\n'}
  local payload=${resp%"$code"}
  payload=${payload%$'\n'}
  case "$code" in
    2*) printf '%s' "$payload" ;;
    *) die "POST $path failed on port $port (HTTP $code): $payload" ;;
  esac
}

rln_get() {
  local port=$1; local path=$2;
  curl -sf "http://127.0.0.1:$port$path" || die "GET $path failed on port $port"
}

wait_for_port() {
  local port=$1; local label=$2; local deadline=$((SECONDS + 30))
  log "Waiting for $label on :$port …"
  # 200 = ready, 403 = locked (not yet init'd) — both mean the daemon is listening
  while true; do
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$port/nodeinfo" 2>/dev/null || echo "000")
    if [ "$code" = "200" ] || [ "$code" = "403" ]; then
      break
    fi
    [ $SECONDS -lt $deadline ] || die "$label did not start within 30s"
    sleep 1
  done
  log "$label ready"
}

wait_for_utexo() {
  local deadline=$((SECONDS + 120))
  log "Waiting for utexo-lsp on :$UTEXO_PORT (may take ~60s on first run for go compile) …"
  while ! curl -sf "http://127.0.0.1:$UTEXO_PORT/health" >/dev/null 2>&1; do
    [ $SECONDS -lt $deadline ] || die "utexo-lsp did not start within 120s"
    sleep 2
  done
  log "utexo-lsp ready"
}

btc_mine() {
  local n=$1
  cd "$RGBLN_REPO"
  docker compose exec -u blits bitcoind bitcoin-cli -regtest -rpcwallet=miner -generate "$n" >/dev/null
  log "Mined $n block(s)"
}

btc_send() {
  local addr=$1; local amt=$2
  cd "$RGBLN_REPO"
  docker compose exec -u blits bitcoind bitcoin-cli -regtest -rpcwallet=miner sendtoaddress "$addr" "$amt" | tr -d '"'
}

# ── stop mode ─────────────────────────────────────────────────────────────────

if [ "${1:-}" = "stop" ]; then
  log "Stopping LSP, Faucet, utexo-lsp, bridge …"
  pkill -f "rgb-lightning-node.*data_lsp"    2>/dev/null || true
  pkill -f "rgb-lightning-node.*data_faucet" 2>/dev/null || true
  pkill -f "go run \."                       2>/dev/null || true
  pkill -f "/utexo-lsp$"                     2>/dev/null || true
  pkill -f "local-node-bridge"               2>/dev/null || true
  # A fixture describing a torn-down stack would send e2e at dead endpoints.
  rm -f "$DEMO_DIR/e2e-fixtures.json"
  log "Done."
  exit 0
fi

# ── preflight ─────────────────────────────────────────────────────────────────

log ""
log "⚠  IMPORTANT: Reset / Cancel any running demo app flow BEFORE continuing."
log "   Active demo nodes stay connected to the LSP. If the cron fires while"
log "   they are connected it creates stuck Initiated Sends → spendable=0."
log ""

[ -x "$RLN_BIN" ] || die "RLN executable not found: $RLN_BIN (build it once in rgb-lightning-node: cargo build --release --locked --bin rgb-lightning-node)"
command -v go >/dev/null || die "go not found — install Go"
command -v jq >/dev/null || die "jq not found — brew install jq"

# RLN is built explicitly when upgrading its version, not on each setup run.
log "Using existing RLN binary: $RLN_BIN"

# ── regtest services (bitcoind + electrs + proxy, optionally vss) ────────────
#
# Started here rather than demanded of the caller — but only when they are
# genuinely down: `regtest.sh start` begins with `down -v` and deletes the
# data dirs, so calling it on a live stack throws away the chain and every
# wallet on it. A docker that cannot be queried is therefore an error, not a
# reason to assume "not running".
cd "$RGBLN_REPO"

regtest_running() { # 0 = up, 1 = down, 2 = docker unreachable
  local out
  out="$(docker compose ps --services --status running 2>/dev/null)" || return 2
  grep -qx bitcoind <<<"$out"
}

port_open() { nc -z -G 1 127.0.0.1 "$1" >/dev/null 2>&1; }

wait_for_tcp() {
  local port=$1 label=$2 deadline=$((SECONDS + 60))
  while ! port_open "$port"; do
    [ $SECONDS -lt $deadline ] || die "$label did not listen on :$port within 60s"
    sleep 1
  done
}

regtest_running && rc=0 || rc=$?
case "$rc" in
  0)
    # bitcoind up is not enough: /unlock needs electrs on :50001. electrs often
    # exits independently (indexer rebuild, docker restart of one container)
    # while bitcoind and proxy stay up. `compose up -d` here is additive — it
    # does NOT run `down -v`, so the chain is kept.
    log "bitcoind is running — ensuring electrs (:50001) and proxy (:3000) …"
    docker compose up -d electrs proxy || die "failed to start electrs/proxy"
    ;;
  1)
    log "Regtest not running — starting it (./regtest.sh start, fresh chain) …"
    # VSS is deliberately NOT passed through: regtest.sh publishes vss-server on
    # :8081, which Metro owns here. The block below starts it on $VSS_PORT.
    VSS= ./regtest.sh start || die "./regtest.sh start failed"
    log "Regtest services started"
    ;;
  *) die "could not query docker compose in $RGBLN_REPO — is Docker running?" ;;
esac
wait_for_tcp 18443 "bitcoind"
wait_for_tcp 50001 "electrs"
wait_for_tcp 3000  "RGB proxy"
log "Regtest services ready (bitcoind :18443, electrs :50001, proxy :3000)"

# The vss profile is part of the same compose project but not of a plain
# `regtest.sh start`, so it is added separately either way.
if [ "${VSS:-}" = "1" ]; then
  [ -f "$VSS_OVERRIDE" ] || die "missing compose overlay: $VSS_OVERRIDE"
  log "Starting vss-server (profile vss) on :$VSS_PORT …"
  VSS_PORT="$VSS_PORT" docker compose -f compose.yaml -f "$VSS_OVERRIDE" \
    --profile vss up -d vss-server || die "failed to start vss-server"
  # vss-server has no GET health route — any HTTP response means it is listening.
  vss_deadline=$((SECONDS + 120))
  while [ "$(curl -s -o /dev/null -w '%{http_code}' "$VSS_URL/getObject" 2>/dev/null || echo 000)" = "000" ]; do
    [ $SECONDS -lt $vss_deadline ] || die "vss-server did not come up on :$VSS_PORT within 120s"
    sleep 2
  done
  log "vss-server ready at $VSS_URL"
fi

# ── local-node-bridge (mine/send helper for demo app) ─────────────────────────

if ! curl -sf "http://127.0.0.1:$BRIDGE_PORT/execute" -d '{"args":"getblockcount"}' >/dev/null 2>&1; then
  log "Starting local-node-bridge on :$BRIDGE_PORT …"
  mkdir -p "$DEMO_DIR/logs"
  RGBLN_REPO="$RGBLN_REPO" node "$DEMO_DIR/scripts/local-node-bridge.js" >"$DEMO_DIR/logs/bridge.log" 2>&1 &
  sleep 2
  curl -sf "http://127.0.0.1:$BRIDGE_PORT/execute" -d '{"args":"getblockcount"}' >/dev/null || die "local-node-bridge failed to start"
  log "local-node-bridge ready"
else
  log "local-node-bridge already running"
fi

# ── start LSP daemon ─────────────────────────────────────────────────────────

pkill -f "rgb-lightning-node.*data_lsp" 2>/dev/null || true
sleep 1
# Always start fresh (mirrors test fixture: new artifact_dir per run)
rm -rf "$LSP_DIR"
mkdir -p "$LSP_DIR" "$RGBLN_REPO/logs" "$DEMO_DIR/logs"
APAY_BEARER_TOKEN="apay-regtest-secret"

log "Starting LSP RLN daemon (port $LSP_PORT, peer $LSP_PEER_PORT) …"
# --lsp-base-url: host node forwards async_order.new P2P messages to utexo-lsp
# --lsp-bearer-token: must match APAY_BEARER_TOKEN in utexo-lsp (fail-closed if empty)
# --enable-virtual-channels-v0: required for async-pay.tsx — User B nodes are created with
#   enableVirtualChannelsV0:true and reject standard anchor channels with "unsupported_scid_alias".
#   Virtual channels (trusted_no_broadcast) avoid the SCID-alias negotiation entirely.
#   Skipped under TWO_ASSETS=1: that flow is on-chain only (no virtual channels
#   anywhere), and the flag's accept-side behavior would force-convert the
#   client's inbound bridge-asset channel open into virtual — see
#   docs/apay-linked-asset-mvp.md "Why no utexo-lsp / node change is needed".
LSP_VIRTUAL_FLAG=""
[ "$TWO_ASSETS" != "1" ] && LSP_VIRTUAL_FLAG="--enable-virtual-channels-v0"
"$RLN_BIN" "$LSP_DIR" \
  --daemon-listening-port "$LSP_PORT" \
  --ldk-peer-listening-port "$LSP_PEER_PORT" \
  --network regtest \
  --disable-authentication \
  $LSP_VIRTUAL_FLAG \
  --lsp-base-url "http://127.0.0.1:$UTEXO_PORT" \
  --lsp-bearer-token "$APAY_BEARER_TOKEN" \
  >"$DEMO_DIR/logs/rln-lsp.log" 2>&1 &
LSP_PID=$!
wait_for_port "$LSP_PORT" "LSP daemon"

# ── start Faucet daemon ───────────────────────────────────────────────────────

pkill -f "rgb-lightning-node.*data_faucet" 2>/dev/null || true
sleep 1
rm -rf "$FAUCET_DIR"
mkdir -p "$FAUCET_DIR"
log "Starting Faucet RLN daemon (port $FAUCET_PORT, peer $FAUCET_PEER_PORT) …"
"$RLN_BIN" "$FAUCET_DIR" \
  --daemon-listening-port "$FAUCET_PORT" \
  --ldk-peer-listening-port "$FAUCET_PEER_PORT" \
  --network regtest \
  --disable-authentication \
  >"$DEMO_DIR/logs/rln-faucet.log" 2>&1 &
FAUCET_PID=$!
wait_for_port "$FAUCET_PORT" "Faucet daemon"

# ── init + unlock ─────────────────────────────────────────────────────────────

log "Initializing LSP node …"
rln_post "$LSP_PORT" "/init" "{\"password\":\"$PASSWORD\"}" >/dev/null

log "Initializing Faucet node …"
rln_post "$FAUCET_PORT" "/init" "{\"password\":\"$PASSWORD\"}" >/dev/null

log "Unlocking LSP …"
rln_post "$LSP_PORT" "/unlock" "$UNLOCK_BODY" >/dev/null

log "Unlocking Faucet …"
rln_post "$FAUCET_PORT" "/unlock" "$UNLOCK_BODY" >/dev/null

# Wait for nodes to finish unlocking (sync, LDK startup, etc.)
log "Waiting for nodes to finish unlocking …"
for port in "$LSP_PORT" "$FAUCET_PORT"; do
  local_deadline=$((SECONDS + 60))
  while true; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$port/nodeinfo" 2>/dev/null || echo "000")
    if [ "$code" = "200" ]; then break; fi
    [ $SECONDS -lt $local_deadline ] || die "Node on :$port did not unlock within 60s (last code: $code)"
    sleep 2
  done
  log "Node on :$port unlocked"
done

# ── get pubkeys ───────────────────────────────────────────────────────────────

LSP_PUBKEY=$(rln_get "$LSP_PORT" "/nodeinfo" | jq -r '.pubkey')
FAUCET_PUBKEY=$(rln_get "$FAUCET_PORT" "/nodeinfo" | jq -r '.pubkey')
log "LSP pubkey:    $LSP_PUBKEY"
log "Faucet pubkey: $FAUCET_PUBKEY"

# ── fund both nodes ───────────────────────────────────────────────────────────

log "Getting addresses …"
LSP_ADDR=$(rln_post "$LSP_PORT"    "/address" | jq -r '.address')
FAUCET_ADDR=$(rln_post "$FAUCET_PORT" "/address" | jq -r '.address')
log "LSP address:    $LSP_ADDR"
log "Faucet address: $FAUCET_ADDR"

log "Funding LSP (1 BTC) …";    btc_send "$LSP_ADDR"    1 >/dev/null
log "Funding Faucet (1 BTC) …"; btc_send "$FAUCET_ADDR" 1 >/dev/null
btc_mine 6
sleep 3

# ── create UTXOs ──────────────────────────────────────────────────────────────

log "Creating $LSP_UTXO_NUM UTXOs on LSP …"
rln_post "$LSP_PORT"    "/createutxos" \
  "{\"up_to\":false,\"num\":$LSP_UTXO_NUM,\"size\":null,\"fee_rate\":7,\"skip_sync\":false}" >/dev/null
log "Creating $FAUCET_UTXO_NUM UTXOs on Faucet …"
rln_post "$FAUCET_PORT" "/createutxos" \
  "{\"up_to\":false,\"num\":$FAUCET_UTXO_NUM,\"size\":null,\"fee_rate\":7,\"skip_sync\":false}" >/dev/null
btc_mine 1
sleep 2

# ── issue RGB assets on Faucet ───────────────────────────────────────────────

# seed_lsp <asset_id> <label> — SEED_ROUNDS sends of SEED_UNITS each, one per
# LSP UTXO (mirrors seed_lsp_from_faucet in the utexo-lsp harness.py).
seed_lsp() {
  local asset_id=$1; local label=$2
  log "Seeding LSP with $SEED_ROUNDS × $SEED_UNITS $label base units from Faucet …"
  local i
  for ((i = 1; i <= SEED_ROUNDS; i++)); do
    log "  $label seed $i/$SEED_ROUNDS …"

    # RGB invoice on LSP — no asset_id (receive any asset, mirrors lsp.rgbinvoice_any())
    local expiry rgb_invoice_resp recipient_id send_body
    expiry=$(($(date +%s) + 3600))
    rgb_invoice_resp=$(rln_post "$LSP_PORT" "/rgbinvoice" \
      "{\"assignment\":{\"type\":\"Any\"},\"expiration_timestamp\":$expiry,\"min_confirmations\":1,\"witness\":false,\"transport_endpoints\":[\"$PROXY_ENDPOINT\"]}")
    recipient_id=$(echo "$rgb_invoice_resp" | jq -r '.recipient_id')
    [ -n "$recipient_id" ] || die "No recipient_id in rgbinvoice response: $rgb_invoice_resp"

    # Note: skip_sync is required by the Rust struct (not in openapi docs)
    # assignment format: {"type":"Fungible","value":N}
    send_body=$(printf '{
  "donation": true,
  "fee_rate": 7,
  "min_confirmations": 1,
  "skip_sync": false,
  "recipient_map": {
    "%s": [
      {
        "recipient_id": "%s",
        "assignment": {"type": "Fungible", "value": %s},
        "transport_endpoints": ["%s"]
      }
    ]
  }
}' "$asset_id" "$recipient_id" "$SEED_UNITS" "$PROXY_ENDPOINT")
    rln_post "$FAUCET_PORT" "/sendrgb" "$send_body" >/dev/null
    btc_mine 1
    sleep 2

    # Double refresh (mirrors harness.py)
    rln_post "$LSP_PORT"    "/refreshtransfers" '{"filter":[],"skip_sync":false}' >/dev/null 2>&1 || true
    rln_post "$LSP_PORT"    "/refreshtransfers" '{"filter":[],"skip_sync":false}' >/dev/null 2>&1 || true
    rln_post "$FAUCET_PORT" "/refreshtransfers" '{"filter":[],"skip_sync":false}' >/dev/null 2>&1 || true
    rln_post "$FAUCET_PORT" "/refreshtransfers" '{"filter":[],"skip_sync":false}' >/dev/null 2>&1 || true
  done

  local bal
  bal=$(rln_post "$LSP_PORT" "/assetbalance" "{\"asset_id\":\"$asset_id\"}" | jq '.settled // 0')
  log "LSP settled balance ($label): $bal"
}

# The bridge asset the BUYER spends. Empty unless TWO_ASSETS=1 — everything
# downstream treats "" as "single-asset stack".
BRIDGE_ASSET_ID=""

# send_rgb_bootstrap <from_port> <to_port> <asset_id> <units> <label>
# Teaches <to_port>'s wallet a contract it did not issue, by actually sending it
# some. The receiving invoice asks for "Any" asset on purpose: the receiver has
# never seen the contract, and /rgbinvoice with an unknown asset_id 403s with
# UnknownContractId. The sender supplies the real asset_id in /sendrgb's
# recipient_map, and receipt is what registers the contract.
send_rgb_bootstrap() {
  local from_port=$1; local to_port=$2; local asset_id=$3; local units=$4; local label=$5
  log "Bootstrap transfer of $units $label base unit(s) → port $to_port …"
  local expiry invoice_resp recipient_id send_body
  expiry=$(($(date +%s) + 3600))
  invoice_resp=$(rln_post "$to_port" "/rgbinvoice" \
    "{\"assignment\":{\"type\":\"Any\"},\"expiration_timestamp\":$expiry,\"min_confirmations\":1,\"witness\":false,\"transport_endpoints\":[\"$PROXY_ENDPOINT\"]}")
  recipient_id=$(echo "$invoice_resp" | jq -r '.recipient_id')
  [ -n "$recipient_id" ] || die "No recipient_id in bootstrap rgbinvoice response: $invoice_resp"
  send_body=$(printf '{
  "donation": true,
  "fee_rate": 7,
  "min_confirmations": 1,
  "skip_sync": false,
  "recipient_map": {
    "%s": [
      {
        "recipient_id": "%s",
        "assignment": {"type": "Fungible", "value": %s},
        "transport_endpoints": ["%s"]
      }
    ]
  }
}' "$asset_id" "$recipient_id" "$units" "$PROXY_ENDPOINT")
  rln_post "$from_port" "/sendrgb" "$send_body" >/dev/null
  btc_mine 1
  sleep 2
  # Double refresh on both sides (mirrors seed_lsp's own pattern): the receiver
  # has to settle the incoming transfer before the contract is usable.
  local p
  for p in "$to_port" "$from_port"; do
    rln_post "$p" "/refreshtransfers" '{"filter":[],"skip_sync":false}' >/dev/null 2>&1 || true
    rln_post "$p" "/refreshtransfers" '{"filter":[],"skip_sync":false}' >/dev/null 2>&1 || true
  done
}

if [ "$TWO_ASSETS" = "1" ]; then
  # ── two independent assets, both issued on the Faucet ───────────────────────
  # Same issuance as the single-asset path, twice. Nothing links the contracts:
  # what makes them interchangeable is CONVERTIBLE_PAIRS on utexo-lsp, below.

  log "Issuing $LN_IFA_TICKER (payout asset, precision $IFA_PRECISION) on Faucet …"
  LN_ISSUE_RESP=$(rln_post "$FAUCET_PORT" "/issueassetifa" \
    "{\"ticker\":\"$LN_IFA_TICKER\",\"name\":\"$LN_IFA_NAME\",\"precision\":$IFA_PRECISION,\"amounts\":[$ISSUE_AMOUNT],\"inflation_amounts\":[$ISSUE_AMOUNT],\"reject_list_url\":null}")
  IFA_ASSET_ID=$(echo "$LN_ISSUE_RESP" | jq -r '.asset.asset_id // .asset_id // empty')
  [ -n "$IFA_ASSET_ID" ] || die "Failed to parse $LN_IFA_TICKER asset_id from: $LN_ISSUE_RESP"
  IFA_TICKER="$LN_IFA_TICKER"
  IFA_NAME="$LN_IFA_NAME"
  log "$LN_IFA_TICKER asset ID: $IFA_ASSET_ID"
  btc_mine 1
  sleep 2

  log "Issuing $BRIDGE_IFA_TICKER (bridge asset, precision $IFA_PRECISION) on Faucet …"
  BRIDGE_ISSUE_RESP=$(rln_post "$FAUCET_PORT" "/issueassetifa" \
    "{\"ticker\":\"$BRIDGE_IFA_TICKER\",\"name\":\"$BRIDGE_IFA_NAME\",\"precision\":$IFA_PRECISION,\"amounts\":[$ISSUE_AMOUNT],\"inflation_amounts\":[$ISSUE_AMOUNT],\"reject_list_url\":null}")
  BRIDGE_ASSET_ID=$(echo "$BRIDGE_ISSUE_RESP" | jq -r '.asset.asset_id // .asset_id // empty')
  [ -n "$BRIDGE_ASSET_ID" ] || die "Failed to parse $BRIDGE_IFA_TICKER asset_id from: $BRIDGE_ISSUE_RESP"
  log "$BRIDGE_IFA_TICKER asset ID: $BRIDGE_ASSET_ID"
  btc_mine 1
  sleep 2

  # The payout asset is the one the cron opens channels in, so the LSP needs a
  # spendable allocation per parallel channel — same multi-round seeding as the
  # single-asset stack.
  seed_lsp "$IFA_ASSET_ID" "$LN_IFA_TICKER"

  # The bridge asset is never seeded (the LSP only ever receives it from buyers),
  # so this dust send is how its node learns the contract at all: /assetmetadata
  # 403s with UnknownContractId until then, and discovery needs the ticker and
  # precision before the buyer's channel exists.
  send_rgb_bootstrap "$FAUCET_PORT" "$LSP_PORT" "$BRIDGE_ASSET_ID" "$BRIDGE_BOOTSTRAP_UNITS" "$BRIDGE_IFA_TICKER"
else
  log "Issuing IFA asset $IFA_TICKER (precision $IFA_PRECISION) on Faucet …"
  IFA_ISSUE_RESP=$(rln_post "$FAUCET_PORT" "/issueassetifa" \
    "{\"ticker\":\"$IFA_TICKER\",\"name\":\"$IFA_NAME\",\"precision\":$IFA_PRECISION,\"amounts\":[$ISSUE_AMOUNT],\"inflation_amounts\":[$ISSUE_AMOUNT],\"reject_list_url\":null}")
  IFA_ASSET_ID=$(echo "$IFA_ISSUE_RESP" | jq -r '.asset.asset_id // .asset_id // empty')
  [ -n "$IFA_ASSET_ID" ] || die "Failed to parse IFA asset_id from: $IFA_ISSUE_RESP"
  log "$IFA_TICKER asset ID: $IFA_ASSET_ID"
  btc_mine 1
  sleep 2

  # ── seed LSP from Faucet ─────────────────────────────────────────────────────

  seed_lsp "$IFA_ASSET_ID" "$IFA_TICKER"
fi

# ── set adb reverse ports so Android emulator can reach proxy + LSP ──────────
# Must happen BEFORE utexo-lsp starts; otherwise cron fires, consignment
# delivery fails (proxy unreachable), and Initiated Sends lock all UTXOs.
if command -v adb >/dev/null 2>&1 && adb devices | grep -q "emulator\|device"; then
  log "Setting adb reverse port forwards …"
  adb reverse tcp:3000 tcp:3000 && log "  tcp:3000 (proxy) ok"      || log "  tcp:3000 (proxy) FAILED — set manually"
  adb reverse tcp:3005 tcp:3005 && log "  tcp:3005 (LSP)   ok"      || log "  tcp:3005 (LSP)   FAILED — set manually"
  adb reverse tcp:3008 tcp:3008 && log "  tcp:3008 (faucet) ok"     || log "  tcp:3008 (faucet) FAILED — set manually"
  adb reverse tcp:8080 tcp:8080 && log "  tcp:8080 (utexo-lsp) ok"  || log "  tcp:8080 (utexo-lsp) FAILED — set manually"
  adb reverse tcp:5000 tcp:5000 && log "  tcp:5000 (bridge) ok"     || log "  tcp:5000 (bridge) FAILED — set manually"
  adb reverse tcp:8081 tcp:8081 && log "  tcp:8081 (Metro JS) ok"   || log "  tcp:8081 (Metro JS) FAILED — set manually"
  adb reverse tcp:8082 tcp:8082 && log "  tcp:8082 (Metro HMR) ok"  || log "  tcp:8082 (Metro HMR) FAILED — set manually"
else
  log "adb not found or no device — skipping port forwards"
  log "  Run manually before starting the app:"
  log "    adb reverse tcp:3000 tcp:3000"
  log "    adb reverse tcp:3005 tcp:3005"
  log "    adb reverse tcp:3008 tcp:3008"
  log "    adb reverse tcp:8080 tcp:8080"
  log "    adb reverse tcp:5000 tcp:5000"
  log "    adb reverse tcp:8081 tcp:8081"
  log "    adb reverse tcp:8082 tcp:8082"
fi

# ── start utexo-lsp ───────────────────────────────────────────────────────────

pkill -f "go run \."  2>/dev/null || true
# Anchored at end-of-command-line: matches the compiled `go run .` child
# binary (…/go-build/…/utexo-lsp) without also matching the RLN daemon's own
# argv, which contains its data dir ($RGBLN_REPO/data_lsp) — when RGBLN_REPO
# is the submodule nested inside a checkout literally named "utexo-lsp"
# (e.g. .../utexo-lsp/rgb-lightning-node), a bare "utexo-lsp" pattern kills
# the just-started LSP daemon too. Confirmed live: the daemon completed its
# whole asset-issue/link sequence, then got a clean shutdown signal at this
# exact point in the script, right before "Starting utexo-lsp" — utexo-lsp's
# own /health has no dependency on the daemon, so wait_for_utexo still
# reported "ready" against a daemon that no longer existed.
pkill -f "/utexo-lsp$"  2>/dev/null || true
sleep 2

# Wipe the database so the new instance starts clean (no stale transfers/assets from previous runs)
rm -f "$UTEXO_LSP_REPO/utexo_lsp.db"
log "Wiped utexo_lsp.db"

# The bridge asset is CONVERTIBLE, not SUPPORTED: utexo-lsp will accept it and
# pay it out over a channel the peer funded itself, but its cron never opens
# channels in it. Adding it to SUPPORTED_ASSET_IDS instead would give every
# connected peer a second channel (connectionsFromPeers loops assets inside the
# peer loop), burn LSP inventory in an asset it does not issue, and make every
# peer's payout asset ambiguous — breaking the direction that already works.
# PAYOUT_ASSET_PREFERENCE decides for a peer that holds both, which is exactly
# the buyer after a checkout: its own bridge channel plus the LNUSDT one the
# cron opened. Preferring the bridge asset means a refund comes back in what the
# buyer actually paid with. See docs/apay-linked-asset-options.uk.md §9.
#
# CONVERTIBLE_PAIRS is what lets the two legs of one payment differ, and it is
# the *whole* authorization: the assets are unrelated contracts, so there is
# nothing on-chain to verify. Both must also be payout-eligible and share a
# precision, which utexo-lsp checks itself. See §10 of the same document.
#
# CHANNEL_PROVISION_GRACE closes the one window where the cron cannot tell a
# self-provisioning client from a peer waiting to be served: between the client's
# connect and its own funding tx it has no channels at all. Without the grace the
# 5 s cron wins that race and hands the buyer a channel in the served asset it
# never asked for. Once the buyer's own channel exists (pending counts), its
# payout asset is established and the cron leaves it alone permanently.
if [ "$TWO_ASSETS" = "1" ]; then
  CONVERTIBLE_ASSET_IDS="${CONVERTIBLE_ASSET_IDS:-$BRIDGE_ASSET_ID}"
  CONVERTIBLE_PAIRS="${CONVERTIBLE_PAIRS:-$IFA_ASSET_ID|$BRIDGE_ASSET_ID}"
  PAYOUT_ASSET_PREFERENCE="${PAYOUT_ASSET_PREFERENCE:-$BRIDGE_ASSET_ID}"
  CHANNEL_PROVISION_GRACE="${CHANNEL_PROVISION_GRACE:-30s}"
  # POST /lightning_send needs the same CONVERTIBLE_PAIRS entry and nothing else,
  # so it rides along with the two-asset stack. Off by default in utexo-lsp: it
  # lets anyone who can reach the API park a HODL invoice on the node.
  LIGHTNING_SEND_ENABLED="${LIGHTNING_SEND_ENABLED:-1}"
  # Ceiling on one relay's asset amount (0 = none, the utexo-lsp default). Set
  # here only so a regtest run carries the same cap signet will — the cart flow
  # relays 100000 base units, three orders of magnitude under it.
  LIGHTNING_SEND_MAX_ASSET_AMOUNT="${LIGHTNING_SEND_MAX_ASSET_AMOUNT:-500000000}"
else
  CONVERTIBLE_ASSET_IDS="${CONVERTIBLE_ASSET_IDS:-}"
  CONVERTIBLE_PAIRS="${CONVERTIBLE_PAIRS:-}"
  PAYOUT_ASSET_PREFERENCE="${PAYOUT_ASSET_PREFERENCE:-}"
  CHANNEL_PROVISION_GRACE="${CHANNEL_PROVISION_GRACE:-0}"
  # Without a convertible pair there is nothing to relay into, so leave it off.
  LIGHTNING_SEND_ENABLED="${LIGHTNING_SEND_ENABLED:-0}"
  LIGHTNING_SEND_MAX_ASSET_AMOUNT="${LIGHTNING_SEND_MAX_ASSET_AMOUNT:-0}"
fi

log "Starting utexo-lsp (port $UTEXO_PORT) with SUPPORTED_ASSET_IDS=$IFA_ASSET_ID ($IFA_TICKER) …"
[ -n "$CONVERTIBLE_ASSET_IDS" ] && log "  CONVERTIBLE_ASSET_IDS=$CONVERTIBLE_ASSET_IDS ($BRIDGE_IFA_TICKER, payout-only — cron never opens it)"
[ -n "$CONVERTIBLE_PAIRS" ] && log "  CONVERTIBLE_PAIRS=$CONVERTIBLE_PAIRS ($IFA_TICKER <-> $BRIDGE_IFA_TICKER, 1:1 — no asset link involved)"
[ "$LIGHTNING_SEND_ENABLED" = "1" ] && log "  LIGHTNING_SEND_ENABLED=1 (POST /lightning_send: pay a third party's BOLT11 out of the other asset)"
[ "$CHANNEL_PROVISION_GRACE" != "0" ] && log "  CHANNEL_PROVISION_GRACE=$CHANNEL_PROVISION_GRACE (cron waits before serving a peer that may open its own channel)"
log "  MIN_AMT_MSAT=$MIN_AMT_MSAT  minSendable=$LN_ADDR_MIN_SENDABLE_MSAT  maxSendable=$LN_ADDR_MAX_SENDABLE_MSAT"
cd "$UTEXO_LSP_REPO"
env \
  LSP_BASE_URL="http://127.0.0.1:$LSP_PORT" \
  RGB_NODE_BASE_URL="http://127.0.0.1:$LSP_PORT" \
  RGB_INVOICE_TRANSPORT_ENDPOINTS="$PROXY_ENDPOINT" \
  LIGHTNING_ADDRESS_DOMAIN_URL="http://127.0.0.1:$UTEXO_PORT" \
  LSP_NODE_HOST="127.0.0.1" \
  LSP_NODE_PORT="$LSP_PEER_PORT" \
  SUPPORTED_ASSET_IDS="$IFA_ASSET_ID" \
  CONVERTIBLE_ASSET_IDS="$CONVERTIBLE_ASSET_IDS" \
  CONVERTIBLE_PAIRS="$CONVERTIBLE_PAIRS" \
  PAYOUT_ASSET_PREFERENCE="$PAYOUT_ASSET_PREFERENCE" \
  LIGHTNING_SEND_ENABLED="$LIGHTNING_SEND_ENABLED" \
  LIGHTNING_SEND_MAX_ASSET_AMOUNT="$LIGHTNING_SEND_MAX_ASSET_AMOUNT" \
  CHANNEL_PROVISION_GRACE="$CHANNEL_PROVISION_GRACE" \
  CRON_EVERY="5s" \
  DELIVERY_RETRY_BASE_DELAY="${DELIVERY_RETRY_BASE_DELAY:-5s}" \
  DELIVERY_RETRY_MAX_DELAY="${DELIVERY_RETRY_MAX_DELAY:-20s}" \
  DEFAULT_CHANNEL_CAPACITY_SAT="$CHANNEL_CAPACITY_SAT" \
  DEFAULT_CHANNEL_PUSH_MSAT="$CHANNEL_PUSH_MSAT" \
  DEFAULT_CHANNEL_ASSET_AMOUNT="$CHANNEL_ASSET_AMOUNT" \
  DEFAULT_VIRTUAL_OPEN_MODE="$VIRTUAL_OPEN_MODE" \
  MIN_AMT_MSAT="$MIN_AMT_MSAT" \
  LIGHTNING_ADDRESS_MIN_SENDABLE_MSAT="$LN_ADDR_MIN_SENDABLE_MSAT" \
  LIGHTNING_ADDRESS_MAX_SENDABLE_MSAT="$LN_ADDR_MAX_SENDABLE_MSAT" \
  EXPIRY_MATCH_TOLERANCE_SEC="30" \
  UTXO_MIN_COUNT="15" \
  UTXO_TARGET_COUNT="25" \
  APAY_BEARER_TOKEN="$APAY_BEARER_TOKEN" \
  APAY_OUTBOUND_MIN_FINAL_CLTV_EXPIRY_DELTA="42" \
  go run . >"$DEMO_DIR/logs/utexo-lsp.log" 2>&1 &
UTEXO_PID=$!
wait_for_utexo

# ── write env file ────────────────────────────────────────────────────────────

# URLs are computed at runtime from Platform.OS (mirrors wallet-flow.ts pattern).
# Only write non-URL values to env files.
cat > "$ENV_OUT" <<EOF
EXPO_PUBLIC_LSP_REGTEST_IFA_ASSET_ID="$IFA_ASSET_ID"
EXPO_PUBLIC_LSP_REGTEST_IFA_TICKER="$IFA_TICKER"
EXPO_PUBLIC_LSP_REGTEST_IFA_PRECISION="$IFA_PRECISION"
EXPO_PUBLIC_LSP_REGTEST_MIN_AMT_MSAT="$MIN_AMT_MSAT"
EXPO_PUBLIC_LSP_REGTEST_CHANNEL_ASSET_AMOUNT="$CHANNEL_ASSET_AMOUNT"
EXPO_PUBLIC_LSP_REGTEST_PEER_PUBKEY="$LSP_PUBKEY"
EXPO_PUBLIC_LSP_REGTEST_LDK_PORT="$LSP_PEER_PORT"
EXPO_PUBLIC_LSP_REGTEST_BRIDGE_ASSET_ID="$BRIDGE_ASSET_ID"
EXPO_PUBLIC_LSP_REGTEST_BRIDGE_TICKER="$BRIDGE_IFA_TICKER"
EOF

# Expo auto-loads .env.local — write LSP regtest vars there.
# Single-source env workflow: keep all active vars in .env.local.
ENV_LOCAL="$DEMO_DIR/.env.local"
if [ -f "$ENV_LOCAL" ]; then
  grep -v "^EXPO_PUBLIC_LSP_REGTEST_\|^EXPO_PUBLIC_FAUCET_REGTEST_" "$ENV_LOCAL" > "$ENV_LOCAL.tmp" && mv "$ENV_LOCAL.tmp" "$ENV_LOCAL"
fi

cat "$ENV_OUT" >> "$ENV_LOCAL"
log "LSP regtest vars written to $ENV_LOCAL (single env-file workflow)"

# ── e2e fixtures — machine-readable, additive to the env files above ──────────
# Consumed by the e2e suites; same shape as the web script's fixture
# (rgb-sdk-web-demo/scripts/start-lsp-web.sh). The emulator reaches every URL
# via the adb reverse forwards set earlier, so 127.0.0.1 stays valid on-device.
FIXTURES="$DEMO_DIR/e2e-fixtures.json"
# Optional keys are omitted, not emptied (§6.0k): a VSS_URL present but blank
# would read as "configured and broken" rather than "not enabled".
VSS_URL_VALUE=""
[ "${VSS:-}" = "1" ] && VSS_URL_VALUE="$VSS_URL"
jq -n \
  --arg vssUrl "$VSS_URL_VALUE" \
  --arg bridgeAssetId "$BRIDGE_ASSET_ID" \
  --arg bridgeTicker "$BRIDGE_IFA_TICKER" \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg ifaAssetId "$IFA_ASSET_ID" \
  --arg ifaTicker "$IFA_TICKER" \
  --argjson ifaPrecision "$IFA_PRECISION" \
  --argjson minAmtMsat "$MIN_AMT_MSAT" \
  --argjson channelAssetAmount "$CHANNEL_ASSET_AMOUNT" \
  --arg lspPubkey "$LSP_PUBKEY" \
  --arg faucetPubkey "$FAUCET_PUBKEY" \
  --arg lspUrl "http://127.0.0.1:$LSP_PORT" \
  --arg faucetUrl "http://127.0.0.1:$FAUCET_PORT" \
  --arg utexoLspUrl "http://127.0.0.1:$UTEXO_PORT" \
  --arg bridgeUrl "http://127.0.0.1:$BRIDGE_PORT" \
  --arg indexerUrl "$INDEXER_URL" \
  --arg proxyEndpoint "$PROXY_ENDPOINT" \
  --argjson lspPeerPort "$LSP_PEER_PORT" \
  --argjson faucetPeerPort "$FAUCET_PEER_PORT" \
  '{
    generatedAt: $generatedAt,
    platform: "rn",
    IFA_ASSET_ID: $ifaAssetId,
    IFA_TICKER: $ifaTicker,
    IFA_PRECISION: $ifaPrecision,
    MIN_AMT_MSAT: $minAmtMsat,
    CHANNEL_ASSET_AMOUNT: $channelAssetAmount,
    LSP_PUBKEY: $lspPubkey,
    FAUCET_PUBKEY: $faucetPubkey,
    LSP_URL: $lspUrl,
    FAUCET_URL: $faucetUrl,
    UTEXO_LSP_URL: $utexoLspUrl,
    BRIDGE_URL: $bridgeUrl,
    INDEXER_URL: $indexerUrl,
    PROXY_ENDPOINT: $proxyEndpoint,
    LSP_PEER_PORT: $lspPeerPort,
    FAUCET_PEER_PORT: $faucetPeerPort
  } + (if $vssUrl == "" then {} else { VSS_URL: $vssUrl } end)
    + (if $bridgeAssetId == "" then {} else
         { BRIDGE_ASSET_ID: $bridgeAssetId, BRIDGE_TICKER: $bridgeTicker } end)' \
  > "$FIXTURES"
log "e2e fixtures written to $FIXTURES"

log ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "  LSP regtest environment ready"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "  utexo-lsp:   http://127.0.0.1:$UTEXO_PORT"
log "  LSP daemon:  http://127.0.0.1:$LSP_PORT  (peer :$LSP_PEER_PORT)"
log "  Faucet:      http://127.0.0.1:$FAUCET_PORT  (peer :$FAUCET_PEER_PORT)"
[ "${VSS:-}" = "1" ] && log "  VSS:         $VSS_URL"
[ "$TWO_ASSETS" = "1" ] && log "  BRIDGE:      $BRIDGE_IFA_TICKER (issuer=Faucet, the buyer spends it): $BRIDGE_ASSET_ID"
log "  SERVING:     $IFA_TICKER (IFA, precision $IFA_PRECISION): $IFA_ASSET_ID"
log "  Channel asset amount: $CHANNEL_ASSET_AMOUNT base units per channel"
log "  MIN_AMT_MSAT:         $MIN_AMT_MSAT msat ($((MIN_AMT_MSAT / 1000)) sat)"
log "  LSP pubkey:  $LSP_PUBKEY"
log "  Env file:    $ENV_OUT"
log "  Fixtures:    $FIXTURES"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "  Start demo app, select Regtest in LSP tab"
if [ "$TWO_ASSETS" = "1" ]; then
  log "  Runnable now: APay Bridge Asset — buyer pays $BRIDGE_IFA_TICKER,"
  log "  merchant is paid $LN_IFA_TICKER, LSP converts 1:1 (on-chain channels only)"
  log "  Both assets are issued on the Faucet and are unrelated contracts —"
  log "  CONVERTIBLE_PAIRS is what makes them interchangeable, not an asset link."
  log "  LSP started WITHOUT --enable-virtual-channels-v0 — the other APay"
  log "  cart/IFA flows won't work against this stack until you restart"
  log "  without TWO_ASSETS=1."
else
  log "  Runnable now: APay Cart Checkout · IFA"
fi
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
