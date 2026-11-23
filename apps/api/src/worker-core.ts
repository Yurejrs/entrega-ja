import { readdir, stat, unlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { ApiConfig } from './config.js';
import type { DbPools } from './db.js';

export type PushSender = (token: string, deliveryId: string, eventType: string) => Promise<void>;

export function createNotificationWorker(pools: DbPools, config: ApiConfig, send: PushSender) {
  async function recoverStale() {
    const result = await pools.worker.query(`UPDATE app.notification_outbox SET status='pending',available_at=now()
      WHERE status='processing' AND processed_at IS NULL AND available_at < now()-interval '10 minutes'`);
    return result.rowCount ?? 0;
  }

  async function recordHeartbeat(error?: unknown, status: 'active'|'error'|'no_credential' = error ? 'error' : 'active') {
    const message = error instanceof Error ? error.message.slice(0, 500) : error ? String(error).slice(0, 500) : null;
    await pools.worker.query(`INSERT INTO app.worker_heartbeats(worker_name,status,last_tick_at,last_success_at,last_error_at,last_error,updated_at)
      VALUES ('notifications',$2,now(),CASE WHEN $1::text IS NULL AND $2='active' THEN now() ELSE NULL END,CASE WHEN $1::text IS NULL THEN NULL ELSE now() END,$1,now())
      ON CONFLICT (worker_name) DO UPDATE SET status=$2,last_tick_at=now(),
        last_success_at=CASE WHEN $1::text IS NULL THEN now() ELSE app.worker_heartbeats.last_success_at END,
        last_error_at=CASE WHEN $1::text IS NULL THEN app.worker_heartbeats.last_error_at ELSE now() END,
        last_error=CASE WHEN $1::text IS NULL THEN NULL ELSE $1 END,updated_at=now()`, [message,status]);
  }

  async function processBatch() {
    const client = await pools.worker.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query<{ id: string; delivery_id: string; device_id: string; event_type: string; attempts: number; fcm_token: string | null }>(`
        SELECT o.id,o.delivery_id,o.device_id,o.event_type,o.attempts,d.fcm_token
        FROM app.notification_outbox o JOIN app.devices d ON d.id=o.device_id
        WHERE o.status='pending' AND o.available_at<=now()
        ORDER BY o.available_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 50`);
      for (const row of claimed.rows) await client.query(`UPDATE app.notification_outbox
        SET status='processing',attempts=attempts+1,available_at=now() WHERE id=$1`, [row.id]);
      await client.query('COMMIT');
      for (const row of claimed.rows) {
        try {
          const current = await pools.worker.query<{ current: boolean }>('SELECT app.notification_is_current($1) AS current', [row.id]);
          if (!current.rows[0]?.current) {
            await pools.worker.query(`UPDATE app.notification_outbox SET status='failed',last_error='superseded',
              processed_at=now() WHERE id=$1 AND status='processing'`, [row.id]);
            continue;
          }
          if (!row.fcm_token) throw new Error('Device has no active FCM token');
          await send(row.fcm_token,row.delivery_id,row.event_type);
          await pools.worker.query(`UPDATE app.notification_outbox SET status='sent',processed_at=now(),last_error=NULL WHERE id=$1`, [row.id]);
        } catch (error) {
          const message = error instanceof Error ? error.message.slice(0, 500) : 'Unknown FCM error';
          const attempts = row.attempts + 1;
          const delaySeconds = Math.min(3600, 30 * 2 ** Math.min(attempts, 7));
          const invalidToken = /registration-token-not-registered|invalid-registration-token/.test(message);
          await pools.worker.query(`UPDATE app.notification_outbox SET status=$1,last_error=$2,
            available_at=now()+($3::int * interval '1 second') WHERE id=$4`,
            [attempts >= 5 || invalidToken ? 'failed' : 'pending', message, delaySeconds, row.id]);
          if (invalidToken) await pools.worker.query('UPDATE app.devices SET revoked_at=now(),fcm_token=NULL WHERE id=$1', [row.device_id]);
        }
      }
      return claimed.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async function* files(dir: string): AsyncGenerator<string> {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir,entry.name);
      if (entry.isDirectory()) yield* files(path);
      else if (entry.isFile()) yield path;
    }
  }

  async function cleanupOrphans() {
    const expiredLocations = await pools.worker.query(`DELETE FROM app.delivery_route_locations
      WHERE captured_at < now() - interval '30 days'`);
    const expiredCourierLocations = await pools.worker.query(`DELETE FROM app.courier_locations
      WHERE captured_at < now() - interval '30 days'`);
    const expiredPhotos = await pools.worker.query<{ storage_key: string }>(
      'SELECT storage_key FROM app.expired_delivery_photo_keys()');
    if (expiredPhotos.rows.length) await pools.worker.query(
      'DELETE FROM app.delivery_photos WHERE storage_key = ANY($1::text[])',
      [expiredPhotos.rows.map(row => row.storage_key)]);
    const expiredEvents = await pools.worker.query<{ id: string }>('SELECT id FROM app.purge_expired_delivery_events()');
    const result = await pools.worker.query<{ storage_key: string }>('SELECT storage_key FROM app.delivery_photos');
    const referenced = new Set(result.rows.map(row => row.storage_key));
    let removed = (expiredPhotos.rowCount ?? 0) + (expiredEvents.rowCount ?? 0);
    for (const row of expiredPhotos.rows) await unlink(join(config.fileStorageDir,row.storage_key)).catch(() => undefined);
    for await (const path of files(config.fileStorageDir)) {
      const key = relative(config.fileStorageDir,path).replaceAll('\\','/');
      if (referenced.has(key)) continue;
      const info = await stat(path);
      if (Date.now() - info.mtimeMs < 24 * 60 * 60 * 1000) continue;
      await unlink(path);
      removed++;
    }
    return removed + (expiredLocations.rowCount ?? 0) + (expiredCourierLocations.rowCount ?? 0);
  }

  return { recoverStale,processBatch,cleanupOrphans,recordHeartbeat };
}
