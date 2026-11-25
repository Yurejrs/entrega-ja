import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const staticConfig = require('../app.json').expo;
const dynamicConfig = require('../app.config.js') as (ctx: { config: Record<string, unknown> }) => Record<string, any>;

test('release config injects the HTTPS API URL and disables cleartext traffic', () => {
  const previous = process.env.EXPO_PUBLIC_API_URL;
  process.env.EXPO_PUBLIC_API_URL = 'https://api.qa.example.test';
  try {
    const config = dynamicConfig({ config: staticConfig });
    assert.equal(config.extra.apiUrl, 'https://api.qa.example.test');
    const buildProperties = config.plugins.find((plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-build-properties');
    assert.equal(buildProperties[1].android.usesCleartextTraffic, false);
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_API_URL;
    else process.env.EXPO_PUBLIC_API_URL = previous;
  }
});
