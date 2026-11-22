import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableDeliveryActions } from '../src/delivery-actions';

test('completion requires a recorded or queued check-in', () => {
  assert.equal(availableDeliveryActions('assigned', []).completion, false);
  assert.equal(availableDeliveryActions('assigned', ['check_in']).completion, true);
  assert.equal(availableDeliveryActions('in_progress', []).completion, true);
  assert.equal(availableDeliveryActions('problem', []).completion, true);
});

test('terminal and conflicting states offer no write actions', () => {
  for (const status of ['completed', 'cancelled']) {
    assert.deepEqual(availableDeliveryActions(status, []), { checkIn: false, problem: false, completion: false });
  }
  assert.deepEqual(availableDeliveryActions('in_progress', ['completion']),
    { checkIn: false, problem: false, completion: false });
});
