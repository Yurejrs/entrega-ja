import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canComplete, shouldLeaveDetail } from '../src/delivery-detail-flow';

test('check-in, photo, note and problem never leave the detail route', () => {
  for (const action of ['check_in', 'photo', 'note', 'problem'] as const) {
    assert.equal(shouldLeaveDetail(action, true), false);
  }
  assert.equal(shouldLeaveDetail('completion', false), false);
  assert.equal(shouldLeaveDetail('completion', true), true);
});

test('completion is blocked until check-in and one photo exist', () => {
  assert.equal(canComplete(false, 0), false);
  assert.equal(canComplete(true, 0), false);
  assert.equal(canComplete(false, 1), false);
  assert.equal(canComplete(true, 1), true);
});
