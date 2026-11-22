import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { api, clearCsrf, csrf, setUnauthorizedHandler } from '../src/api.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearCsrf();
  setUnauthorizedHandler(null);
});

test('an expired session is reported to the application', async () => {
  let expired = false;
  setUnauthorizedHandler(() => { expired = true; });
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Sessão expirada' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
  await assert.rejects(csrf(), (error: { status?: number }) => error.status === 401);
  assert.equal(expired, true);
});

test('a network failure has a clear recoverable error', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(api('/tenant/dashboard'), (error: { status?: number; message?: string }) =>
    error.status === 0 && /conectar à API/.test(error.message ?? ''));
});
