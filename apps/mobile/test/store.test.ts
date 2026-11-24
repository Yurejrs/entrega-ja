import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import type { Delivery } from '../src/api';
import { accountKey } from '../src/account-key';
import { createStore, type StoreDatabase } from '../src/store-core';

function adapter(connection: DatabaseSync): StoreDatabase {
  return {
    execSync(sql) { connection.exec(sql); },
    getAllSync<T>(sql: string, ...params: unknown[]) {
      return connection.prepare(sql).all(...params as SQLInputValue[]) as T[];
    },
    getFirstSync<T>(sql: string, ...params: unknown[]) {
      return connection.prepare(sql).get(...params as SQLInputValue[]) as T | undefined;
    },
    runSync(sql, ...params) {
      return connection.prepare(sql).run(...params as SQLInputValue[]);
    },
    withTransactionSync(callback) {
      connection.exec('BEGIN IMMEDIATE');
      try {
        callback();
        connection.exec('COMMIT');
      } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function delivery(id: string, extra: Record<string, unknown> = {}): Delivery {
  return { id, customer_name: 'Cliente de teste', ...extra } as Delivery;
}

test('cached delivery and pending operation survive a database reopen for the same account', () => {
  const directory = mkdtempSync(join(tmpdir(), 'entrega-ja-mobile-'));
  const path = join(directory, 'entregaja.db');
  const key = accountKey('tenant-1', 'courier-1');
  let connection = new DatabaseSync(path);
  let store = createStore(adapter(connection), () => 'operation-1');
  store.prepareAccount(key);
  store.applySync([delivery('delivery-1')], [], '2026-11-19T12:00:00.000Z');
  const operationId = store.enqueue('delivery-1', 'check_in', { latitude: -3.7, longitude: -38.5 });
  assert.equal(operationId, 'operation-1');
  connection.close();

  connection = new DatabaseSync(path);
  store = createStore(adapter(connection), () => 'operation-2');
  store.prepareAccount(key);
  assert.deepEqual(store.deliveries().map(item => item.id), ['delivery-1']);
  assert.equal(store.getMeta('since'), '2026-11-19T12:00:00.000Z');
  assert.equal(store.operations().length, 1);
  assert.equal(JSON.parse(store.operations()[0].payload).clientOperationId, 'operation-1');
  connection.close();
  rmSync(directory, { recursive: true, force: true });
});

test('a reassign removal clears the cache and retains the queued operation as a conflict', () => {
  const connection = new DatabaseSync(':memory:');
  const store = createStore(adapter(connection), () => 'operation-1');
  store.prepareAccount(accountKey('tenant-1', 'courier-1'));
  store.applySync([delivery('delivery-1')], [], '2026-11-19T12:00:00.000Z');
  store.enqueue('delivery-1', 'check_in', { latitude: -3.7, longitude: -38.5 });

  store.applySync([], ['delivery-1'], '2026-11-19T12:05:00.000Z');

  assert.deepEqual(store.deliveries(), []);
  assert.deepEqual(store.operations(), []);
  assert.equal(store.failedOperations()[0].error, 'Entrega reatribuída');
  assert.equal(store.getMeta('since'), '2026-11-19T12:05:00.000Z');
  connection.close();
});

test('the current assignment wins a removal from an older sync window', () => {
  const connection = new DatabaseSync(':memory:');
  const store = createStore(adapter(connection), () => 'operation-1');
  store.prepareAccount(accountKey('tenant-1', 'courier-1'));
  store.applySync([delivery('delivery-1')], [], '2026-11-19T12:00:00.000Z');
  store.enqueue('delivery-1', 'check_in', { latitude: -3.7, longitude: -38.5 });

  store.applySync([delivery('delivery-1', { status: 'assigned' })], ['delivery-1'], '2026-11-19T12:05:00.000Z');

  assert.deepEqual(store.deliveries().map(item => item.id), ['delivery-1']);
  assert.equal(store.operations().length, 1);
  assert.equal(store.failedOperations().length, 0);
  connection.close();
});

test('sync applies removals, deliveries and the since marker atomically', () => {
  const connection = new DatabaseSync(':memory:');
  const store = createStore(adapter(connection), () => 'operation-1');
  store.prepareAccount(accountKey('tenant-1', 'courier-1'));
  store.applySync([delivery('delivery-1')], [], '2026-11-19T12:00:00.000Z');
  store.enqueue('delivery-1', 'check_in', { latitude: -3.7, longitude: -38.5 });

  assert.throws(() => store.applySync(
    [delivery('delivery-2', { invalid: 1n })], ['delivery-1'], '2026-11-19T12:05:00.000Z'),
    /BigInt/);

  assert.deepEqual(store.deliveries().map(item => item.id), ['delivery-1']);
  assert.equal(store.operations().length, 1);
  assert.equal(store.failedOperations().length, 0);
  assert.equal(store.getMeta('since'), '2026-11-19T12:00:00.000Z');
  connection.close();
});

test('a different account cannot reuse cached deliveries or queued operations', () => {
  const connection = new DatabaseSync(':memory:');
  const store = createStore(adapter(connection), () => 'operation-1');
  store.prepareAccount(accountKey('tenant-1', 'courier-1'));
  store.applySync([delivery('delivery-1')], [], '2026-11-19T12:00:00.000Z');
  store.enqueue('delivery-1', 'check_in', { latitude: -3.7, longitude: -38.5 });

  store.prepareAccount(accountKey('tenant-2', 'courier-2'));

  assert.deepEqual(store.deliveries(), []);
  assert.deepEqual(store.operations(), []);
  assert.equal(store.getMeta('since'), undefined);
  connection.close();
});

test('a failed operation can be explicitly returned to the automatic retry queue', () => {
  const connection = new DatabaseSync(':memory:');
  const store = createStore(adapter(connection), () => 'operation-1');
  store.prepareAccount(accountKey('tenant-1', 'courier-1'));
  store.enqueue('delivery-1', 'check_in', { latitude: -3.7, longitude: -38.5 });
  store.fail('operation-1', 'Conflito na API');
  assert.equal(store.operations().length, 0);
  assert.equal(store.failedOperations().length, 1);
  store.retryFailed('operation-1');
  assert.equal(store.failedOperations().length, 0);
  assert.equal(store.operations().length, 1);
  connection.close();
});

test('an offline clock-out survives logout and belongs only to its courier', () => {
  const db = new DatabaseSync(':memory:');
  const store = createStore(adapter(db), () => 'operation');
  const courier = accountKey('tenant','first');
  const exit = JSON.stringify({id:'shift',startedAt:'2026-11-24T09:00:00Z',stoppedAt:'2026-11-24T17:00:00Z'});
  store.prepareAccount(courier);
  store.setShiftState(exit);
  store.reset();
  store.prepareAccount(accountKey('tenant','second'));
  assert.equal(store.getShiftState(),undefined);
  store.prepareAccount(courier);
  assert.equal(store.getShiftState(),exit);
  store.setShiftState(null);
  assert.equal(store.getShiftState(),undefined);
  db.close();
});
