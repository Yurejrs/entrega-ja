import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import { configuredBaseUrl } from './api';
import { queueRoutePoint, routePoints, removeRoutePoints, discardRoutePoints } from './store';
import { drainRoutePoints, retryAsync } from './route-sync-core';

const TASK='entregaja-route-location';
const flushes = new Map<string, Promise<void>>();
async function send(routeId:string,locations:Location.LocationObject[]){
 const token=await SecureStore.getItemAsync('session');if(!token)return;
 const points=locations.map(location=>({clientPointId:randomUUID(),latitude:location.coords.latitude,longitude:location.coords.longitude,accuracyM:location.coords.accuracy??0,capturedAt:new Date(location.timestamp).toISOString()}));
 for(const point of points)queueRoutePoint(routeId,point);
 await flushRoutePoints(routeId);
}
export async function flushRoutePoints(routeId:string){
 const current=flushes.get(routeId);if(current)return current;
 const run=(async()=>{const token=await SecureStore.getItemAsync('session');if(!token)return;const base=await configuredBaseUrl();await drainRoutePoints(
   ()=>routePoints(routeId),
   async batch=>retryAsync(async()=>{const response=await fetch(`${base}/v1/mobile/routes/${routeId}/locations`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({points:batch.map(row=>JSON.parse(row.payload))})});if(!response.ok){if(response.status>=400&&response.status<500&&response.status!==429)throw new Error(`GPS rejeitado (${response.status})`);throw new Error('GPS pendente de sincronização');}const body=await response.json() as {confirmedClientPointIds?:string[]};return new Set(body.confirmedClientPointIds??[]);}),
   ids=>removeRoutePoints(ids),
 );})();
 flushes.set(routeId,run);try{await run}finally{if(flushes.get(routeId)===run)flushes.delete(routeId)}
}
TaskManager.defineTask(TASK,async({data,error})=>{
 if(error||!data)return;
 const routeId=await SecureStore.getItemAsync('activeRouteId');if(!routeId)return;
 const locations=(data as {locations:Location.LocationObject[]}).locations;
 try{await send(routeId,locations)}catch{/* The next foreground sync reports stale location; queued upload is added separately. */}
});

export async function startRouteTracking(routeId:string){
 const foreground=await Location.requestForegroundPermissionsAsync();if(!foreground.granted)throw new Error('Permita o acesso à localização para iniciar a rota.');
 const background=await Location.requestBackgroundPermissionsAsync();if(!background.granted)throw new Error('Permita a localização em segundo plano para iniciar a rota.');
 const token=await SecureStore.getItemAsync('session');if(!token)throw new Error('Sessão expirada.');
 const base=await configuredBaseUrl();const response=await fetch(`${base}/v1/mobile/routes/${routeId}/start`,{method:'POST',headers:{Authorization:`Bearer ${token}`}});if(!response.ok)throw new Error('Não foi possível iniciar a rota no servidor.');
 await SecureStore.setItemAsync('activeRouteId',routeId);
 try{await Location.startLocationUpdatesAsync(TASK,{accuracy:Location.Accuracy.Balanced,timeInterval:15000,distanceInterval:25,foregroundService:{notificationTitle:'Rota em andamento',notificationBody:'O Entrega Já está compartilhando sua localização.',notificationColor:'#0F4C5C'}});}catch(error){try{const cancelled=await fetch(`${base}/v1/mobile/routes/${routeId}/cancel`,{method:'POST',headers:{Authorization:`Bearer ${token}`}});if(cancelled.ok)await stopRouteTracking();}catch{}throw error;}
}
export async function stopRouteTracking(){if(await Location.hasStartedLocationUpdatesAsync(TASK))await Location.stopLocationUpdatesAsync(TASK);await SecureStore.deleteItemAsync('activeRouteId');}
export async function cancelRouteTracking(){const routeId=await SecureStore.getItemAsync('activeRouteId');if(!routeId){await stopRouteTracking();return;}const token=await SecureStore.getItemAsync('session');if(!token)throw new Error('Sessão expirada.');await flushRoutePoints(routeId);const base=await configuredBaseUrl();const response=await fetch(`${base}/v1/mobile/routes/${routeId}/cancel`,{method:'POST',headers:{Authorization:`Bearer ${token}`}});if(!response.ok)throw new Error('Não foi possível cancelar a rota no servidor.');await stopRouteTracking();discardRoutePoints(routeId);}
export async function resumeRouteTracking(){const routeId=await SecureStore.getItemAsync('activeRouteId');if(!routeId)return;const token=await SecureStore.getItemAsync('session');if(!token)return;const base=await configuredBaseUrl();const response=await fetch(`${base}/v1/mobile/routes/${routeId}`,{headers:{Authorization:`Bearer ${token}`}});if(response.status===404){await stopRouteTracking();discardRoutePoints(routeId);return;}if(!response.ok)throw new Error('Não foi possível retomar o acompanhamento da rota.');const route=await response.json() as {status:string};if(route.status!=='active'){await stopRouteTracking();discardRoutePoints(routeId);return;}await flushRoutePoints(routeId);if(!await Location.hasStartedLocationUpdatesAsync(TASK))await Location.startLocationUpdatesAsync(TASK,{accuracy:Location.Accuracy.Balanced,timeInterval:15000,distanceInterval:25,foregroundService:{notificationTitle:'Rota em andamento',notificationBody:'O Entrega Já está compartilhando sua localização.',notificationColor:'#0F4C5C'}});}
