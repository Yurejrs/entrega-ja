import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localDeliveryPhotos } from '../src/local-photos';
import type { Operation } from '../src/store-core';

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'completion-1', delivery_id: 'delivery-1', kind: 'completion',
    payload: JSON.stringify({ photoUri: 'file:///proof.jpg', occurredAt: '2026-11-19T20:00:00.000Z' }),
    status: 'pending', error: null, ...overrides,
  };
}

test('shows a locally captured photo until its completion operation syncs', () => {
  assert.deepEqual(localDeliveryPhotos([operation()], 'delivery-1'), [{
    id: 'completion-1', uri: 'file:///proof.jpg', capturedAt: '2026-11-19T20:00:00.000Z', status: 'pending',
  }]);
});

test('keeps failed completion photos inspectable and ignores unrelated or malformed operations', () => {
  const failed = operation({ status: 'failed', error: 'Entrega reatribuída' });
  const otherDelivery = operation({ id: 'completion-2', delivery_id: 'delivery-2' });
  const checkIn = operation({ id: 'checkin-1', kind: 'check_in' });
  const malformed = operation({ id: 'bad', payload: '{' });
  assert.deepEqual(localDeliveryPhotos([failed, otherDelivery, checkIn, malformed], 'delivery-1'), [{
    id: 'completion-1', uri: 'file:///proof.jpg', capturedAt: '2026-11-19T20:00:00.000Z', status: 'failed',
  }]);
});
