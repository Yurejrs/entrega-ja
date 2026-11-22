import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { randomUUID } from 'expo-crypto';
import { request } from './api';

Notifications.setNotificationHandler({handleNotification:async()=>({shouldShowBanner:true,shouldShowList:true,shouldPlaySound:true,shouldSetBadge:false})});

async function installationId(){let id=await SecureStore.getItemAsync('installationId');if(!id){id=randomUUID();await SecureStore.setItemAsync('installationId',id)}return id}
export async function registerDevice():Promise<{pushReady:boolean;permissionGranted:boolean;reason:string}>{
 if(!Device.isDevice)return {pushReady:false,permissionGranted:false,reason:'Push exige um aparelho Android físico.'};
 const id=await installationId();
 const current=await Notifications.getPermissionsAsync();
 const permission=current.granted?current:await Notifications.requestPermissionsAsync();
 let fcmToken:string|undefined;
 let reason='';
 if(permission.granted){
  await Notifications.setNotificationChannelAsync('deliveries',{name:'Entregas',importance:Notifications.AndroidImportance.HIGH});
  try{fcmToken=(await Notifications.getDevicePushTokenAsync()).data as string}catch{reason='Os avisos com o app fechado não estão disponíveis neste aparelho.';}
 }else reason='Permita os avisos nas configurações do aparelho.';
 await request(`/mobile/devices/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify(fcmToken?{fcmToken}:{})});
 return {pushReady:!!fcmToken,permissionGranted:permission.granted,reason:fcmToken?'Notificações push configuradas.':reason};
}
export async function unregisterDevice(){const id=await SecureStore.getItemAsync('installationId');if(id)await request(`/mobile/devices/${encodeURIComponent(id)}`,{method:'DELETE'}).catch(()=>{});}
export function onNotification(refresh:()=>void){const received=Notifications.addNotificationReceivedListener(refresh);const tapped=Notifications.addNotificationResponseReceivedListener(refresh);return()=>{received.remove();tapped.remove()}}
