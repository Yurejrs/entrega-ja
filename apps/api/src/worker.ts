import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { loadConfig } from './config.js';
import { createPools } from './db.js';
import { createNotificationWorker } from './worker-core.js';

const config = loadConfig();
const pools = createPools(config);
const projectId = process.env.FCM_PROJECT_ID;
const missingCredentials = !projectId;
if (!missingCredentials && !getApps().length) initializeApp({ credential: applicationDefault(), projectId });
const worker = createNotificationWorker(pools,config,async (token,deliveryId,eventType) => {
  if (missingCredentials) throw new Error('FCM_PROJECT_ID is not configured');
  await getMessaging().send({ token, data: { deliveryId,eventType },
    android: { priority: 'high', notification: { sound: 'default', channelId: 'deliveries' } },
    notification: { title: 'Nova entrega', body: 'Abra o aplicativo para ver os detalhes.' } });
});

let running = false;
async function tick() {
  if (running) return;
  running = true;
  let tickError: unknown;
  try {
    if (missingCredentials) {
      console.warn(JSON.stringify({ event: 'worker.no_credentials', time: new Date().toISOString(), fallback: 'operational-dashboard' }));
    } else {
      await worker.recoverStale();
      let count: number;
      do { count = await worker.processBatch(); } while (count === 50);
      console.log(JSON.stringify({ event: 'worker.tick', time: new Date().toISOString() }));
    }
  } catch (error) { tickError = error; console.error(JSON.stringify({ event: 'worker.error', message: String(error) })); }
  finally { await worker.recordHeartbeat(tickError, missingCredentials ? 'no_credential' : tickError ? 'error' : 'active').catch(heartbeatError => console.error(JSON.stringify({ event: 'worker.heartbeat.error', message: String(heartbeatError) }))); running = false; }
}
await tick();
setInterval(tick, 5 * 60 * 1000);
setInterval(() => worker.cleanupOrphans().then(count => console.log(JSON.stringify({ event: 'files.cleanup', count })))
  .catch(error => console.error(error)), 24 * 60 * 60 * 1000);
process.on('SIGTERM', async () => { await pools.close(); process.exit(0); });
process.on('SIGINT', async () => { await pools.close(); process.exit(0); });
