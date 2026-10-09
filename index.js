// Expo Router can evaluate route modules before _layout. Install native
// polyfills before importing the router (and therefore any SDK clients).
require('./utils/runtime-polyfills');
require('expo-router/entry');
