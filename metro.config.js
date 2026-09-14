// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const { createRequire } = require('module');
const path = require('path');

const sdkRequire = createRequire(require.resolve('@utexo/rgb-sdk-rn/package.json'));
const coreEntry = sdkRequire.resolve('@utexo/rgb-sdk-core');
const coreEntries = new Map([
  ['@utexo/rgb-sdk-core', coreEntry],
  [
    '@utexo/rgb-sdk-core/conformance',
    sdkRequire.resolve('@utexo/rgb-sdk-core/conformance'),
  ],
]);
/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

config.resolver = {
  ...config.resolver,
  nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  unstable_enablePackageExports: false,
  // Metro's package-exports enforcement (enabled by default in Metro 0.83 / RN 0.81)
  // blocks relative imports that aren't listed in a package's `exports` field.
  // expo-constants@18 only exports `.` and `./package.json`, so `./ExponentConstants`
  // fails even though the file exists.  resolveRequest short-circuits that check.
  resolveRequest: (context, moduleName, platform) => {
    const coreFile = coreEntries.get(moduleName);
    if (coreFile) {
      return context.resolveRequest(context, coreFile, platform);
    }
    if (
      moduleName === './ExponentConstants' &&
      context.originModulePath.includes('expo-constants/build/Constants.js')
    ) {
      return {
        filePath: path.resolve(
          path.dirname(context.originModulePath),
          'ExponentConstants.js'
        ),
        type: 'sourceFile',
      };
    }
    return context.resolveRequest(context, moduleName, platform);
  },
};

module.exports = config;
