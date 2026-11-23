import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import { configuredBaseUrl } from './api';
import { liveLocationPoints, queueLivePoint, removeLiveLocationPoints, discardLiveLocationPoints } from './store';
import { drainRoutePoints, retryAsync } from './route-sync-core';

const TASK = 'entregaja-live-location';
let flushing: Promise<void> | null = null;

async function send(locations: Location.LocationObject[]) {
  for (const location of locations) queueLivePoint({
    clientPointId: randomUUID(), latitude: location.coords.latitude, longitude: location.coords.longitude,
    accuracyM: location.coords.accuracy ?? 0, capturedAt: new Date(location.timestamp).toISOString(),
  });
  await flushLiveLocations();
}

export async function flushLiveLocations() {
  if (flushing) return flushing;
  flushing = (async () => {
    const token = await SecureStore.getItemAsync('session');
    if (!token) return;
    const base = await configuredBaseUrl();
    await drainRoutePoints(
      () => liveLocationPoints(),
      async batch => retryAsync(async () => {
        const response = await fetch(`${base}/v1/mobile/location-sharing/locations`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ points: batch.map(row => JSON.parse(row.payload)) }),
        });
        if (!response.ok) throw new Error(response.status >= 400 && response.status < 500 && response.status !== 429
          ? `GPS rejeitado (${response.status})` : 'GPS pendente de sincronização');
        const body = await response.json() as { confirmedClientPointIds?: string[] };
        return new Set(body.confirmedClientPointIds ?? []);
      }),
      ids => removeLiveLocationPoints(ids),
    );
  })();
  try { await flushing; } finally { flushing = null; }
}

TaskManager.defineTask(TASK, async ({ data, error }) => {
  if (error || !data) return;
  const enabled = await SecureStore.getItemAsync('liveLocationEnabled');
  if (enabled !== 'true') return;
  const locations = (data as { locations: Location.LocationObject[] }).locations;
  try { await send(locations); } catch { /* preserved in the local queue for the next run */ }
});

export async function startLiveLocation() {
  const foreground = await Location.requestForegroundPermissionsAsync();
  if (!foreground.granted) throw new Error('Permita o acesso à localização para ativar o compartilhamento.');
  const background = await Location.requestBackgroundPermissionsAsync();
  if (!background.granted) throw new Error('Permita a localização em segundo plano para manter o compartilhamento ativo.');
  const token = await SecureStore.getItemAsync('session');
  if (!token) throw new Error('Sessão expirada.');
  const base = await configuredBaseUrl();
  const response = await fetch(`${base}/v1/mobile/location-sharing`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { message?: string }).message ?? 'Não foi possível ativar o compartilhamento.');
  await SecureStore.setItemAsync('liveLocationEnabled', 'true');
  try {
    if (!await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.startLocationUpdatesAsync(TASK, {
      accuracy: Location.Accuracy.Balanced, timeInterval: 15000, distanceInterval: 25,
      pausesUpdatesAutomatically: false, showsBackgroundLocationIndicator: true,
      foregroundService: { notificationTitle: 'Localização compartilhada', notificationBody: 'O Entrega Já está atualizando sua posição para a gestão.', notificationColor: '#0F4C5C' },
    });
  } catch (error) {
    await SecureStore.deleteItemAsync('liveLocationEnabled');
    await fetch(`${base}/v1/mobile/location-sharing`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).catch(() => {});
    throw error;
  }
}

export async function stopLiveLocation() {
  const token = await SecureStore.getItemAsync('session');
  const base = await configuredBaseUrl();
  if (await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK);
  await SecureStore.deleteItemAsync('liveLocationEnabled');
  discardLiveLocationPoints();
  if (token) await fetch(`${base}/v1/mobile/location-sharing`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).catch(() => {});
}

export async function resumeLiveLocation() {
  if (await SecureStore.getItemAsync('liveLocationEnabled') !== 'true') return;
  if (!await Location.hasStartedLocationUpdatesAsync(TASK)) {
    await Location.startLocationUpdatesAsync(TASK, { accuracy: Location.Accuracy.Balanced, timeInterval: 15000, distanceInterval: 25, pausesUpdatesAutomatically: false, showsBackgroundLocationIndicator: true, foregroundService: { notificationTitle: 'Localização compartilhada', notificationBody: 'O Entrega Já está atualizando sua posição para a gestão.', notificationColor: '#0F4C5C' } });
  }
}
