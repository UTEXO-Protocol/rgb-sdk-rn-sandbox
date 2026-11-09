module.exports = {
  project: {
    ios: {
      automaticPodsInstallation: true,
    },
  },
  dependencies: {
    // RGB_L1 runs on @utexo/rgb-lib-rn. @utexo/rgb-sdk-rn stays installed for
    // the RLN code and types only: its native module would clash with
    // rgb-lib-rn (both register the TurboModule `RgbLib` and ship RGBLib), so
    // it is not linked. RLN screens build but cannot run in this app.
    '@utexo/rgb-sdk-rn': {
      platforms: { ios: null, android: null },
    },
  },
};
