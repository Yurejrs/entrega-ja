import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountKey, isSameAccount } from '../src/account-key';

const key = accountKey('tenant-1', 'user-1');

test('a previous URL-prefixed key preserves pending work for the same account', () => {
  assert.equal(isSameAccount('http://10.10.0.40:3000|tenant-1|user-1', key), true);
  assert.equal(isSameAccount('http://10.10.0.4:3000|tenant-1|user-1', key), true);
  assert.equal(isSameAccount(key, key), true);
});

test('another user or tenant must not reuse local deliveries', () => {
  assert.equal(isSameAccount(undefined, key), false);
  assert.equal(isSameAccount('http://server|tenant-2|user-1', key), false);
  assert.equal(isSameAccount('http://server|tenant-1|user-2', key), false);
});
