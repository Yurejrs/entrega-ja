const fs = require('node:fs');
const path = require('node:path');
const appConfig = require('./app.json').expo;
const googleServicesPath = path.join(__dirname, 'google-services.json');

module.exports = {
  expo: {
    ...appConfig,
    android: {
      ...appConfig.android,
      ...(fs.existsSync(googleServicesPath)
        ? { googleServicesFile: './google-services.json' }
        : { googleServicesFile: undefined }),
    },
  },
};
