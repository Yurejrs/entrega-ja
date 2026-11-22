import { mkdir, writeFile, unlink, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { ApiConfig } from './config.js';
import { badRequest } from './errors.js';
import { sha256 } from './security.js';

export type StoredPhoto = { key: string; mime: string; size: number; hash: string };
export type PreparedPhoto = { bytes: Buffer; sourceHash: string };

function detectMime(data: Buffer): { mime: string; extension: string } | null {
  if (data.length >= 3 && data.subarray(0, 3).equals(Buffer.from([0xff,0xd8,0xff]))) return { mime: 'image/jpeg', extension: 'jpg' };
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime: 'image/png', extension: 'png' };
  if (data.length >= 12 && data.toString('ascii',0,4) === 'RIFF' && data.toString('ascii',8,12) === 'WEBP') return { mime: 'image/webp', extension: 'webp' };
  return null;
}

export async function preparePhoto(data: Buffer, declaredMime: string): Promise<PreparedPhoto> {
  if (!data.length || data.length > 8 * 1024 * 1024) badRequest('Foto deve ter até 8 MB');
  const actual = detectMime(data);
  if (!actual || actual.mime !== declaredMime) badRequest('Formato de foto inválido');
  try {
    const image = sharp(data, { failOn: 'error', limitInputPixels: 20_000_000 });
    const metadata = await image.metadata();
    if (!['jpeg','png','webp'].includes(metadata.format ?? '')) badRequest('Formato de foto inválido');
    const bytes = await image.rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true})
      .jpeg({quality:78,mozjpeg:true}).toBuffer();
    return { bytes, sourceHash: sha256(data) };
  } catch { badRequest('Foto não pode ser decodificada'); }
}

export async function savePhoto(config: ApiConfig, tenantId: string, deliveryId: string, data: Buffer): Promise<StoredPhoto> {
  const key = `${tenantId}/${deliveryId}/${randomUUID()}.jpg`;
  const path = join(config.fileStorageDir, key);
  const stagingDir = join(config.fileStorageDir,'staging');
  const stagingPath = join(stagingDir,`${randomUUID()}.part`);
  await mkdir(stagingDir,{recursive:true,mode:0o700});
  await mkdir(join(config.fileStorageDir,tenantId,deliveryId), { recursive: true, mode: 0o700 });
  try {
    await writeFile(stagingPath, data, { flag: 'wx', mode: 0o600 });
    await rename(stagingPath,path);
  } catch (error) {
    await unlink(stagingPath).catch(() => undefined);
    throw error;
  }
  return { key, mime: 'image/jpeg', size: data.length, hash: sha256(data) };
}

export async function removePhoto(config: ApiConfig, key: string): Promise<void> {
  await unlink(safePhotoPath(config,key)).catch(() => undefined);
}

export function safePhotoPath(config: ApiConfig, key: string): string {
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(key)) badRequest('Caminho de arquivo inválido');
  const path = resolve(config.fileStorageDir,key);
  if (!path.startsWith(`${config.fileStorageDir}/`)) badRequest('Caminho de arquivo inválido');
  return path;
}

export function readPhoto(config: ApiConfig, key: string) { return createReadStream(safePhotoPath(config,key)); }
