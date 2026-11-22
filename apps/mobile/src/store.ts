import * as SQLite from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { createStore } from './store-core';

const db = SQLite.openDatabaseSync('entregaja.db');
const store = createStore(db, randomUUID);

export const {
  deliveries,
  getMeta,
  prepareAccount,
  enqueue,
  operations,
  failedOperations,
  clearFailed,
  retryFailed,
  complete,
  fail,
  applySync,
  reset,
  queueRoutePoint, routePoints, removeRoutePoints, discardRoutePoints,
} = store;
export type { Operation } from './store-core';
