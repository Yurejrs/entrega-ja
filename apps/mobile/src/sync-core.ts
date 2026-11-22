export type SyncPage<T extends {id:string}>={items:T[];nextCursor:string|null;removedDeliveryIds:string[];removalsNextCursor:string|null;serverTime:string};
export type SyncResult<T extends {id:string}>={items:T[];removedIds:string[];serverTime:string};

export async function collectSyncPages<T extends {id:string}>(since:string|null,fetchPage:(query:URLSearchParams)=>Promise<SyncPage<T>>,limit=50):Promise<SyncResult<T>>{
 let cursor:string|null=null,removalCursor:string|null=null,until:string|null=null;
 let deliveriesDone=false,removalsDone=false;
 const staged=new Map<string,T>(),removed=new Set<string>(),seen=new Set<string>();
 do{
  const query=new URLSearchParams({limit:String(limit)});
  if(since)query.set('since',since);if(until)query.set('until',until);
  if(cursor)query.set('cursor',cursor);if(removalCursor)query.set('removalCursor',removalCursor);
  const page=await fetchPage(query);
  if(until&&page.serverTime!==until)throw new Error('A janela de sincronização mudou');
  until=page.serverTime;
  if(!deliveriesDone){for(const item of page.items)staged.set(item.id,item);deliveriesDone=page.items.length<limit||!page.nextCursor;cursor=deliveriesDone?null:page.nextCursor}
  if(!removalsDone){for(const id of page.removedDeliveryIds)removed.add(id);removalsDone=page.removedDeliveryIds.length<limit||!page.removalsNextCursor;removalCursor=removalsDone?null:page.removalsNextCursor}
  const marker=`${cursor}:${removalCursor}`;
  if(!deliveriesDone||!removalsDone){if(seen.has(marker))throw new Error('Paginação de sincronização repetida');seen.add(marker)}
 }while(!deliveriesDone||!removalsDone);
 if(!until)throw new Error('Sincronização sem horário do servidor');
 return {items:[...staged.values()],removedIds:[...removed].filter(id=>!staged.has(id)),serverTime:until};
}
