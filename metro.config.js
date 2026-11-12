// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const { createRequire } = require('module');
const path = require('path');

/**
 * `@utexo/*` subpaths (`@utexo/rgb-sdk/webrgb`, `@utexo/rgb-sdk-rn-rln/webrgb`,
 * `@utexo/rgb-sdk-core/conformance`) exist only in package `exports`, which
 * Metro does not read here. Resolve them as Node does, from the importing file,
 * so @utexo/rgb-sdk-rn-rln keeps its own core (1.0.0-beta.9) and the new packages
 * share the app's @utexo/rgb-sdk-core.
 */
function resolveUtexoSubpath(moduleName, originModulePath) {
  if (!/^@utexo\/[^/]+\/.+/.test(moduleName)) return null;
  try {
    return createRequire(originModulePath).resolve(moduleName);
  } catch {
    return null;
  }
}
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
    // Share React with the installed SDK, while retaining nested dependency
    // versions (WalletConnect uses noble v1; the RGB SDK uses noble v2).
    if (
      moduleName === 'react' ||
      moduleName.startsWith('react/') ||
      moduleName === 'react-native' ||
      moduleName.startsWith('react-native/')
    ) {
      const name =
        platform === 'web' && moduleName === 'react-native'
          ? 'react-native-web'
          : moduleName;
      return context.resolveRequest(
        context,
        path.resolve(__dirname, 'node_modules', name),
        platform
      );
    }
    const subpath = resolveUtexoSubpath(moduleName, context.originModulePath);
    if (subpath) {
      return context.resolveRequest(context, subpath, platform);
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
