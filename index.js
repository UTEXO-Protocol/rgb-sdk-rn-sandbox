require('./utils/runtime-polyfills');
const { registerRootComponent } = require('expo');
registerRootComponent(require('./App').default);
