module.exports = {
  project: {
    ios: {
      automaticPodsInstallation: true,
    },
  },
  dependencies: {
    // RGB_L1 runs on @utexo/rgb-sdk-rn (the local L1 engine). The published
    // RLN package @utexo/rgb-sdk-rn@1.0.0-beta.40 is installed under the alias
    // @utexo/rgb-sdk-rn-rln for the RLN code and types only: its native module
    // would clash with the L1 engine (both register the TurboModule `RgbLib`
    // and ship RGBLib), so it is not linked. RLN screens build but cannot run
    // in this app.
    '@utexo/rgb-sdk-rn-rln': {
      platforms: { ios: null, android: null },
    },
  },
};
