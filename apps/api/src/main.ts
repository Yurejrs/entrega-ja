import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { mkdir } from 'node:fs/promises';

const config = loadConfig();
await mkdir(config.fileStorageDir,{recursive:true,mode:0o700});
const { app } = await buildServer(config);
await app.listen({ host: config.host, port: config.port });
for (const signal of ['SIGTERM','SIGINT'] as const) {
  process.once(signal, () => { app.close().then(() => process.exit(0)).catch(() => process.exit(1)); });
}
