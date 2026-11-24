import type { Delivery } from './api';
import { isSameAccount } from './account-key';

export interface StoreDatabase {
  execSync(sql: string): void;
  getAllSync<T>(sql: string, ...params: unknown[]): T[];
  getFirstSync<T>(sql: string, ...params: unknown[]): T | undefined;
  runSync(sql: string, ...params: unknown[]): unknown;
  withTransactionSync(callback: () => void): void;
}

export type Operation = {
  id: string; delivery_id: string; kind: 'check_in' | 'problem' | 'completion' | 'photo' | 'note';
  payload: string; status: string; error: string | null;
};

export function createStore(db: StoreDatabase, createId: () => string) {
  db.execSync(`
    CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_shifts (account TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, kind TEXT NOT NULL,
      payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT
    );
    CREATE TABLE IF NOT EXISTS route_points (id TEXT PRIMARY KEY, route_id TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS live_location_points (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
  `);

  function deliveries(): Delivery[] {
    return db.getAllSync<{ payload: string }>('SELECT payload FROM deliveries ORDER BY id DESC')
      .map(row => JSON.parse(row.payload));
  }

  function getMeta(key: string): string | undefined {
    return db.getFirstSync<{ value: string }>('SELECT value FROM metadata WHERE key=?', key)?.value;
  }

  function prepareAccount(accountKey: string): void {
    db.withTransactionSync(() => {
      if (!isSameAccount(getMeta('accountKey'), accountKey)) {
        db.execSync('DELETE FROM deliveries; DELETE FROM metadata; DELETE FROM operations;');
      }
      db.runSync('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)', 'accountKey', accountKey);
    });
  }

  function enqueue(deliveryId: string, kind: Operation['kind'], payload: Record<string, unknown>): string {
    const id = createId();
    db.runSync('INSERT INTO operations(id,delivery_id,kind,payload,status) VALUES (?,?,?,?,?)',
      id, deliveryId, kind, JSON.stringify({ ...payload, clientOperationId: id }), 'pending');
    return id;
  }

  function operations(): Operation[] {
    return db.getAllSync<Operation>(`SELECT * FROM operations WHERE status='pending' ORDER BY rowid`);
  }

  function failedOperations(): Operation[] {
    return db.getAllSync<Operation>(`SELECT * FROM operations WHERE status='failed' ORDER BY rowid`);
  }

  function clearFailed(): Operation[] {
    const failed = failedOperations();
    db.runSync("DELETE FROM operations WHERE status='failed'");
    return failed;
  }

  function complete(id: string): void {
    db.runSync('DELETE FROM operations WHERE id=?', id);
  }

  function fail(id: string, error: string): void {
    db.runSync(`UPDATE operations SET status='failed',error=? WHERE id=?`, error, id);
  }

  function retryFailed(id: string): void {
    db.runSync(`UPDATE operations SET status='pending',error=NULL WHERE id=? AND status='failed'`, id);
  }

  function applySync(items: Delivery[], removedIds: string[], serverTime: string): void {
    db.withTransactionSync(() => {
      const active = new Set(items.map(item => item.id));
      for (const id of removedIds) {
        if (active.has(id)) continue;
        db.runSync('DELETE FROM deliveries WHERE id=?', id);
        db.runSync(`UPDATE operations SET status='failed',error='Entrega reatribuída'
          WHERE delivery_id=? AND status='pending'`, id);
      }
      for (const item of items) db.runSync('INSERT OR REPLACE INTO deliveries(id,payload) VALUES (?,?)', item.id, JSON.stringify(item));
      db.runSync('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)', 'since', serverTime);
    });
  }

  function reset(): void {
    db.withTransactionSync(() => {
      db.execSync('DELETE FROM deliveries; DELETE FROM metadata; DELETE FROM operations; DELETE FROM route_points; DELETE FROM live_location_points;');
    });
  }

  function queueRoutePoint(routeId:string,payload:Record<string,unknown>):void{db.runSync('INSERT OR IGNORE INTO route_points(id,route_id,payload) VALUES(?,?,?)',String(payload.clientPointId),routeId,JSON.stringify(payload));}
  function routePoints(routeId:string){return db.getAllSync<{id:string;payload:string}>('SELECT id,payload FROM route_points WHERE route_id=? ORDER BY rowid',routeId);}
  function removeRoutePoints(ids:string[]){db.withTransactionSync(()=>{for(const id of ids)db.runSync('DELETE FROM route_points WHERE id=?',id);});}
  function discardRoutePoints(routeId:string){db.runSync('DELETE FROM route_points WHERE route_id=?',routeId);}
  function queueLivePoint(payload:Record<string,unknown>):void{db.runSync('INSERT OR IGNORE INTO live_location_points(id,payload) VALUES(?,?)',String(payload.clientPointId),JSON.stringify(payload));}
  function liveLocationPoints(){return db.getAllSync<{id:string;payload:string}>('SELECT id,payload FROM live_location_points ORDER BY rowid');}
  function removeLiveLocationPoints(ids:string[]){db.withTransactionSync(()=>{for(const id of ids)db.runSync('DELETE FROM live_location_points WHERE id=?',id);});}
  function discardLiveLocationPoints(){db.runSync('DELETE FROM live_location_points');}

  function getShiftState() {
    return db.getFirstSync<{value:string}>('SELECT value FROM work_shifts WHERE account=?',getMeta('accountKey')??'')?.value;
  }
  function setShiftState(value:string|null) {
    const account=getMeta('accountKey');
    if(!account)return;
    if(value===null)db.runSync('DELETE FROM work_shifts WHERE account=?',account);
    else db.runSync('INSERT OR REPLACE INTO work_shifts(account,value) VALUES (?,?)',account,value);
  }
  function cacheProofCount(id:string,count:number) {
    db.runSync('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)', 'proofCount:'+id,String(count));
  }
  function cacheRouteOverview(value:string) {
    db.runSync("INSERT OR REPLACE INTO metadata(key,value) VALUES ('routeOverview',?)",value);
  }
  return { deliveries, getMeta, getShiftState, setShiftState, cacheProofCount, cacheRouteOverview, prepareAccount, enqueue, operations, failedOperations,
    clearFailed, complete, fail, retryFailed, applySync, reset, queueRoutePoint, routePoints, removeRoutePoints, discardRoutePoints,
    queueLivePoint, liveLocationPoints, removeLiveLocationPoints, discardLiveLocationPoints };
}
