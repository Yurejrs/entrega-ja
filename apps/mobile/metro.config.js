const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const resolveDefault = config.resolver.resolveRequest;

// Workspace libraries must use the same hook dispatcher as the native renderer.
config.resolver.resolveRequest = (context, name, platform) => {
  if (name === 'react' || name.startsWith('react/')) {
    return { type: 'sourceFile', filePath: require.resolve(name, { paths: [__dirname] }) };
  }
  return (resolveDefault ?? context.resolveRequest)(context, name, platform);
};

module.exports = config;
