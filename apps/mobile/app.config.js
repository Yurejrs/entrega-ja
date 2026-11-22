const fs = require('node:fs');
const path = require('node:path');
const appConfig = require('./app.json').expo;
const googleServicesPath = path.join(__dirname, 'google-services.json');

module.exports = {
  expo: {
    ...appConfig,
    extra: {
      ...appConfig.extra,
      ...(process.env.EXPO_PUBLIC_API_URL ? { apiUrl: process.env.EXPO_PUBLIC_API_URL.replace(/\/$/, '') } : {}),
    },
    android: {
      ...appConfig.android,
      ...(fs.existsSync(googleServicesPath)
        ? { googleServicesFile: './google-services.json' }
        : { googleServicesFile: undefined }),
    },
  },
};
