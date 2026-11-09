# Dev Next Android demo wallet

This draft shares the demo wallet implementation used for bridge testing. It
opens a standalone on-chain RGB screen instead of the general SDK playground.
The old playground files remain in the repository but are not part of this
entry point or its TypeScript check. This is an Android reference build, not a
replacement for the production Utexo Wallet or a cross-platform release.

## Dependencies and build

The SDK dependency is pinned to the companion [SDK draft PR #72](https://github.com/UTEXO-Protocol/rgb-sdk-rn/pull/72) commit. It requires an
externally built, matching Android AAR. Follow `docs/android-v6-demo.md` in the
installed SDK; its local Maven installer must run **before** building Android.
The unpublished AAR is not included here and cannot be downloaded from Maven
Central. Installing the npm dependencies alone is not enough to build the APK.

```sh
npm install
cd node_modules/@utexo/rgb-sdk-rn
npm run bindings:rgb-lib:android -- /path/to/rgb-lib-bfa-v6-release.aar
cd ../../..
EXPO_NO_DOTENV=1 npx expo prebuild --platform android --no-install
EXPO_NO_DOTENV=1 npm run android:release
```

Use `EXPO_NO_DOTENV=1` for this profile so the repository's older tracked `.env`
does not override the Dev defaults. Pass any required overrides directly in the
process environment. For WalletConnect, set your own
`EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID`; receiving and sending without a website
do not require a WalletConnect project. No keys, personal `.env`, keystores or
binary artifacts are part of this change.

Default services:

- Indexer: `https://dev.esplora-01.mint.utexo.com`
- RGB proxy: `rpcs://dev.rgb-proxy.utexo.com/json-rpc`
- EVM RPC: `https://arb1.arbitrum.io/rpc` (Arbitrum 42161)
- Native source: unmodified RGB-lib BFA v6, `5010eefa355beb9c42a4c1b69883f7651241a111`

Do not use the gateway RPC as a substitute without checking device connectivity.
The app can copy RPC and refresh diagnostics without copying raw RPC responses
or wallet keys. Dev services may require the appropriate network access; this
PR does not change their access controls.

## Implemented flows

- A fresh v6 wallet, with separate SecureStore, native data and WalletConnect
  storage; existing wallet data is not migrated or deleted.
- Receive invoices and Send with a user-entered token amount, including invoices
  with no fixed amount. Send validates the token, balance, receiver key,
  transport and expiration before the native call.
- Burn with an explicit payout network/address and export either the original
  raw `.rgb` proof or one JSON package containing proof and destination record.
  The package is `format: "utexo-burn"`, `version: 1`, with base64
  `consignment.data` and `burnDestination` metadata. Packaging does not change
  the native proof bytes.
- WalletConnect approval, persisted burn recovery, and transfer diagnostics.

Receive, send and burn are the relevant comparison points for the production
wallet implementation. A transfer in `WaitingCounterparty` may still require
the receiving wallet to refresh and acknowledge the consignment before broadcast.

## Validation

```sh
npm run typecheck
npm run test:devnext
```

The original local build also passed Android release assembly. The draft tests
exercise this standalone profile with native stubs. The older playground tests
target the previous multi-profile service and are not a validation of this
entry point. Phone testing and a live mint/send/burn round trip remain necessary
for the target environment. The AAR publication, iOS port, and migration of old
wallets are outside this draft.
