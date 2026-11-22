import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { executeRequest } from '../src/http-core';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('network failures remain retryable', async () => {
  globalThis.fetch = async () => { throw new TypeError('Network request failed'); };
  await assert.rejects(executeRequest('/v1/mobile/sync', 'token'),
    (error: { status?: number; code?: string; message?: string }) =>
      error.status === 0 && error.code === 'NETWORK_ERROR' && /Sem conexão/.test(error.message ?? ''));
});

test('a stalled request times out even if fetch ignores cancellation', async () => {
  globalThis.fetch = async () => new Promise<Response>(() => {});
  await assert.rejects(executeRequest('/v1/mobile/sync', 'token', {}, 10),
    (error: { status?: number; code?: string; message?: string }) =>
      error.status === 0 && error.code === 'NETWORK_ERROR' && /demorou/.test(error.message ?? ''));
});

test('HTTP errors retain their status for conflict and session handling', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Conflito', code: 'CONFLICT' }), {
    status: 409,
    headers: { 'Content-Type': 'application/json' },
  });
  await assert.rejects(executeRequest('/v1/deliveries/id/check-ins', 'token'),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === 'CONFLICT');
});
