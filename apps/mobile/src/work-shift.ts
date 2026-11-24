import { getShiftState, setShiftState } from './store';
import { request } from './api';

export type Shift = {id:string;startedAt:string;stoppedAt?:string};
export function currentShift():Shift|null {
  return JSON.parse(getShiftState() || 'null');
}
export function activeShift() {
  const shift=currentShift();
  return shift && !shift.stoppedAt ? shift : null;
}
export function saveShift(shift:Shift|null) {setShiftState(shift?JSON.stringify(shift):null);}
// An interrupted clock-in is reconciled as an exit on the next launch.
let openingId:string|null=null;
export function markOpening(id:string|null){openingId=id;}
export async function syncExit() {
  const shift=currentShift();
  if(!shift?.stoppedAt || shift.id===openingId)return;
  await request('/mobile/location-sharing',{method:'PUT',body:JSON.stringify({enabled:false,shiftId:shift.id,stoppedAt:shift.stoppedAt})});
  if(currentShift()?.id===shift.id)saveShift(null);
}
