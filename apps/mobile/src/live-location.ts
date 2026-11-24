import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import { request } from './api';
import { liveLocationPoints, queueLivePoint, removeLiveLocationPoints, discardLiveLocationPoints, discardRoutePoints } from './store';
import { drainRoutePoints } from './route-sync-core';
import { sendRouteLocations, stopLegacyRouteGPS } from './route-tracking';
import { activeShift, currentShift, markOpening, saveShift, syncExit } from './work-shift';

const TASK='entregaja-live-location';
let flushing:Promise<void>|null=null;

async function startGPS() {
  if(await Location.hasStartedLocationUpdatesAsync(TASK))return;
  if(!activeShift())return;
  await Location.startLocationUpdatesAsync(TASK,{accuracy:Location.Accuracy.Balanced,timeInterval:15000,distanceInterval:25,
    pausesUpdatesAutomatically:false,showsBackgroundLocationIndicator:true,foregroundService:{
      notificationTitle:'Turno em andamento',notificationBody:'Sua localização é compartilhada até você registrar a saída.',notificationColor:'#0F4C5C'}});
}
async function stopGPS() {
  if(await Location.hasStartedLocationUpdatesAsync(TASK))await Location.stopLocationUpdatesAsync(TASK);
}
async function flushLiveLocations(id:string) {
  if(flushing)return flushing;
  flushing=drainRoutePoints(()=>activeShift()?.id===id?liveLocationPoints():[],async batch=>{
    const result=await request<{confirmedClientPointIds:string[]}>('/mobile/location-sharing/locations',{
      method:'POST',body:JSON.stringify({shiftId:id,points:batch.map(row=>JSON.parse(row.payload))})});
    return new Set(result.confirmedClientPointIds);
  },removeLiveLocationPoints).then(()=>{});
  try {await flushing;} finally {flushing=null;}
}

TaskManager.defineTask(TASK,async({data,error})=>{
  const shift=activeShift();
  if(!shift){await stopGPS();return;}
  if(error||!data)return;
  const routeId=await SecureStore.getItemAsync('activeRouteId');
  if(activeShift()?.id!==shift.id)return;
  const locations=(data as {locations:Location.LocationObject[]}).locations.filter(l=>l.timestamp>=Date.parse(shift.startedAt));
  for(const l of locations)queueLivePoint({clientPointId:randomUUID(),latitude:l.coords.latitude,longitude:l.coords.longitude,
    accuracyM:l.coords.accuracy??0,capturedAt:new Date(l.timestamp).toISOString()});
  const [sent]=await Promise.allSettled([flushLiveLocations(shift.id),routeId?sendRouteLocations(routeId,locations,shift.id):undefined]);
  if(sent.status==='rejected' && [401,409].includes(sent.reason?.status) && activeShift()?.id===shift.id)await stopLiveLocation();
});

export async function startLiveLocation() {
  await syncExit();
  if(activeShift())return startGPS();
  if(!(await Location.requestForegroundPermissionsAsync()).granted)throw new Error('Permita a localização para registrar a entrada.');
  if(!(await Location.requestBackgroundPermissionsAsync()).granted)throw new Error('Permita a localização em segundo plano durante o turno.');
  const id=randomUUID();
  // Persist a compensating exit before contacting the server in case the reply is lost.
  const now=new Date().toISOString();
  markOpening(id);
  saveShift({id,startedAt:now,stoppedAt:now});
  try {
    const result=await request<{startedAt:string}>('/mobile/location-sharing',{method:'PUT',body:JSON.stringify({enabled:true,shiftId:id})});
    discardLiveLocationPoints();
    saveShift({id,startedAt:result.startedAt});
    await startGPS();
  } catch(error){markOpening(null);await stopLiveLocation();throw error;}
  finally {markOpening(null);}
}
export async function stopLiveLocation() {
  const shift=currentShift();
  if(shift&&!shift.stoppedAt)saveShift({...shift,stoppedAt:new Date().toISOString()});
  discardLiveLocationPoints();
  const route=await SecureStore.getItemAsync('activeRouteId');
  if(route)discardRoutePoints(route);
  await Promise.allSettled([stopGPS(),stopLegacyRouteGPS(),syncExit()]);
}
export async function resumeLiveLocation() {
  await stopLegacyRouteGPS();
  if(activeShift())await startGPS();
  else {await stopGPS();await syncExit();}
}
