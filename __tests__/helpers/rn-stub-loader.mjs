// Load the SDK's public API in Node tests without an installed native module.
// Any accidental native call must fail; tests supply their own wallet backend.
const url = 'rn-stub:react-native';
const source = `
export const TurboModuleRegistry = {
  getEnforcing: () => new Proxy({}, { get: () => () => {
    throw new Error('Native calls are unavailable in Node tests');
  }}),
  get: () => null,
};
export const NativeModules = {};
export const Platform = { OS: 'node', select: (options) => options.default ?? options.native };
export default { TurboModuleRegistry, NativeModules, Platform };
`;

export async function resolve(specifier, context, next) {
  if (specifier === 'react-native') return { url, shortCircuit: true };
  return next(specifier, context);
}

export async function load(specifier, context, next) {
  if (specifier === url) return { format: 'module', source, shortCircuit: true };
  return next(specifier, context);
}
