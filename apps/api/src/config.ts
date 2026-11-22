import { resolve } from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export type ApiConfig = {
  host: string;
  port: number;
  authDatabaseUrl: string;
  tenantDatabaseUrl: string;
  platformDatabaseUrl: string;
  workerDatabaseUrl: string;
  fileStorageDir: string;
  mfaKey: Buffer;
  cookieSecure: boolean;
};

export function loadConfig(): ApiConfig {
  const key = required('MFA_ENCRYPTION_KEY_HEX');
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error('MFA_ENCRYPTION_KEY_HEX must contain 64 hex characters');
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  return {
    host: process.env.HOST ?? '127.0.0.1',
    port,
    authDatabaseUrl: required('DATABASE_URL_AUTH'),
    tenantDatabaseUrl: required('DATABASE_URL_TENANT'),
    platformDatabaseUrl: required('DATABASE_URL_PLATFORM'),
    workerDatabaseUrl: required('DATABASE_URL_WORKER'),
    fileStorageDir: resolve(process.env.FILE_STORAGE_DIR ?? './private-files'),
    mfaKey: Buffer.from(key, 'hex'),
    cookieSecure: process.env.COOKIE_SECURE !== 'false',
  };
}
