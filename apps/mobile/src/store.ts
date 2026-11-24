import * as SQLite from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { createStore } from './store-core';

const db = SQLite.openDatabaseSync('entregaja.db');
const store = createStore(db, randomUUID);

export const {
  deliveries,
  getMeta, getShiftState, setShiftState,
  cacheProofCount,
  cacheRouteOverview,
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
  queueLivePoint, liveLocationPoints, removeLiveLocationPoints, discardLiveLocationPoints,
} = store;
export type { Operation } from './store-core';
