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
  checkInMaxDistanceM: number;
  gpsMaxFutureSkewSeconds: number;
  gpsMaxAgeDays: number;
  gpsLowPrecisionThresholdM: number;
  locationPolicyVersion: string;
  mfaKey: Buffer;
  cookieSecure: boolean;
};

export function loadConfig(): ApiConfig {
  const key = required('MFA_ENCRYPTION_KEY_HEX');
  if (!/^[0-9a-fA-F]{64}$/.test(key)) throw new Error('MFA_ENCRYPTION_KEY_HEX must contain 64 hex characters');
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const checkInMaxDistanceM = Number(process.env.CHECK_IN_MAX_DISTANCE_M ?? '200');
  if (!Number.isFinite(checkInMaxDistanceM) || checkInMaxDistanceM < 1 || checkInMaxDistanceM > 5000) throw new Error('Invalid CHECK_IN_MAX_DISTANCE_M');
  const gpsMaxFutureSkewSeconds = Number(process.env.GPS_MAX_FUTURE_SKEW_SECONDS ?? '300');
  const gpsMaxAgeDays = Number(process.env.GPS_MAX_AGE_DAYS ?? '30');
  const gpsLowPrecisionThresholdM = Number(process.env.GPS_LOW_PRECISION_THRESHOLD_M ?? '200');
  if (!Number.isFinite(gpsMaxFutureSkewSeconds) || gpsMaxFutureSkewSeconds < 0 || gpsMaxFutureSkewSeconds > 86400) throw new Error('Invalid GPS_MAX_FUTURE_SKEW_SECONDS');
  if (!Number.isFinite(gpsMaxAgeDays) || gpsMaxAgeDays < 1 || gpsMaxAgeDays > 3650) throw new Error('Invalid GPS_MAX_AGE_DAYS');
  if (!Number.isFinite(gpsLowPrecisionThresholdM) || gpsLowPrecisionThresholdM < 1 || gpsLowPrecisionThresholdM > 5000) throw new Error('Invalid GPS_LOW_PRECISION_THRESHOLD_M');
  const cookieSecure = process.env.COOKIE_SECURE !== 'false';
  if (process.env.NODE_ENV === 'production' && !cookieSecure) throw new Error('COOKIE_SECURE=false não é permitido em produção; use HTTPS');
  return {
    host: process.env.HOST ?? '127.0.0.1',
    port,
    authDatabaseUrl: required('DATABASE_URL_AUTH'),
    tenantDatabaseUrl: required('DATABASE_URL_TENANT'),
    platformDatabaseUrl: required('DATABASE_URL_PLATFORM'),
    workerDatabaseUrl: required('DATABASE_URL_WORKER'),
    fileStorageDir: resolve(process.env.FILE_STORAGE_DIR ?? './private-files'),
    checkInMaxDistanceM,
    gpsMaxFutureSkewSeconds,
    gpsMaxAgeDays,
    gpsLowPrecisionThresholdM,
    locationPolicyVersion: process.env.LOCATION_POLICY_VERSION ?? '1.0.0',
    mfaKey: Buffer.from(key, 'hex'),
    cookieSecure,
  };
}
