export function toggleRouteSelection(ids:string[],deliveryId:string):string[]{
  return ids.includes(deliveryId)?ids.filter(id=>id!==deliveryId):[...ids,deliveryId];
}
