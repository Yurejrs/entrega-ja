import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import { activeShift } from './work-shift';
import { configuredBaseUrl, request } from './api';
import { queueRoutePoint, routePoints, removeRoutePoints, discardRoutePoints } from './store';
import { drainRoutePoints, retryAsync } from './route-sync-core';

const TASK='entregaja-route-location';
const flushes = new Map<string, Promise<void>>();
export async function sendRouteLocations(routeId:string,locations:Location.LocationObject[],shiftId:string){
 const token=await SecureStore.getItemAsync('session');if(!token)return;
 const points=locations.map(location=>({clientPointId:randomUUID(),latitude:location.coords.latitude,longitude:location.coords.longitude,accuracyM:location.coords.accuracy??0,capturedAt:new Date(location.timestamp).toISOString()}));
 if(activeShift()?.id!==shiftId)return;
 for(const point of points)queueRoutePoint(routeId,{...point,shiftId});
 await flushRoutePoints(routeId);
}
export async function flushRoutePoints(routeId:string){
 const shift=activeShift();if(!shift)return;
 const current=flushes.get(routeId);if(current)return current;
 const run=(async()=>{const token=await SecureStore.getItemAsync('session');if(!token)return;await drainRoutePoints(
   ()=>activeShift()?.id===shift.id?routePoints(routeId).filter(row=>JSON.parse(row.payload).shiftId===shift.id):[],
   async batch=>retryAsync(async()=>{if(activeShift()?.id!==shift.id)throw new Error('Turno encerrado.');const body=await request<{confirmedClientPointIds?:string[]}>(`/mobile/routes/${routeId}/locations`,{method:'POST',body:JSON.stringify({shiftId:shift.id,points:batch.map(row=>{const {shiftId,...point}=JSON.parse(row.payload);return point;})})});return new Set(body.confirmedClientPointIds??[]);}),
   ids=>removeRoutePoints(ids),
 );})();
 flushes.set(routeId,run);try{await run}finally{if(flushes.get(routeId)===run)flushes.delete(routeId)}
}
// Older installations may still have this native task registered.
export async function stopLegacyRouteGPS() {
 if(await Location.hasStartedLocationUpdatesAsync(TASK))await Location.stopLocationUpdatesAsync(TASK);
}
TaskManager.defineTask(TASK,stopLegacyRouteGPS);

export async function startRouteTracking(routeId:string){
 const token=await SecureStore.getItemAsync('session');if(!token)throw new Error('Sessão expirada.');
 const base=await configuredBaseUrl();const response=await fetch(`${base}/v1/mobile/routes/${routeId}/start`,{method:'POST',headers:{Authorization:`Bearer ${token}`}});if(!response.ok)throw new Error('Não foi possível iniciar a rota no servidor.');
 await SecureStore.setItemAsync('activeRouteId',routeId);

}
export async function stopRouteTracking(){if(await Location.hasStartedLocationUpdatesAsync(TASK))await Location.stopLocationUpdatesAsync(TASK);await SecureStore.deleteItemAsync('activeRouteId');}
export async function cancelRouteTracking(){const routeId=await SecureStore.getItemAsync('activeRouteId');if(!routeId){await stopRouteTracking();return;}const token=await SecureStore.getItemAsync('session');if(!token)throw new Error('Sessão expirada.');await flushRoutePoints(routeId);const base=await configuredBaseUrl();const response=await fetch(`${base}/v1/mobile/routes/${routeId}/cancel`,{method:'POST',headers:{Authorization:`Bearer ${token}`}});if(!response.ok)throw new Error('Não foi possível cancelar a rota no servidor.');await stopRouteTracking();discardRoutePoints(routeId);}
export async function resumeRouteTracking(){const routeId=await SecureStore.getItemAsync('activeRouteId');if(!routeId)return;const token=await SecureStore.getItemAsync('session');if(!token)return;const base=await configuredBaseUrl();const response=await fetch(`${base}/v1/mobile/routes/${routeId}`,{headers:{Authorization:`Bearer ${token}`}});if(response.status===404){await stopRouteTracking();discardRoutePoints(routeId);return;}if(!response.ok)throw new Error('Não foi possível retomar o acompanhamento da rota.');const route=await response.json() as {status:string};if(route.status!=='active'){await stopRouteTracking();discardRoutePoints(routeId);return;}await flushRoutePoints(routeId);}
