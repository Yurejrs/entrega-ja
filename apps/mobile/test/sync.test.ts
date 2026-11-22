import assert from 'node:assert/strict';
import {test} from 'node:test';
import {collectSyncPages,type SyncPage} from '../src/sync-core';
type Item={id:string};
const time='2026-11-18T12:00:00.000Z';

test('all pages share one cutoff and a current assignment wins over an old removal',async()=>{
 const queries:URLSearchParams[]=[];
 const pages:SyncPage<Item>[]= [
  {items:[{id:'a'},{id:'b'}],nextCursor:'b',removedDeliveryIds:['a','gone'],removalsNextCursor:'gone',serverTime:time},
  {items:[{id:'c'}],nextCursor:'c',removedDeliveryIds:['orphan'],removalsNextCursor:'orphan',serverTime:time}
 ];
 const result=await collectSyncPages<Item>('2026-11-17T12:00:00.000Z',async query=>{queries.push(query);return pages[queries.length-1]},2);
 assert.deepEqual(result.items.map(item=>item.id),['a','b','c']);
 assert.deepEqual(result.removedIds,['gone','orphan']);
 assert.equal(result.serverTime,time);
 assert.equal(queries[1].get('until'),time);
 assert.equal(queries[1].get('since'),queries[0].get('since'));
 assert.equal(queries[1].get('cursor'),'b');
 assert.equal(queries[1].get('removalCursor'),'gone');
});

test('an exhausted removal stream does not discard deliveries on later pages',async()=>{
 let calls=0;
 const result=await collectSyncPages<Item>(null,async()=>{calls++;return calls===1
  ?{items:[{id:'a'},{id:'b'}],nextCursor:'b',removedDeliveryIds:[],removalsNextCursor:null,serverTime:time}
  :{items:[{id:'c'}],nextCursor:'c',removedDeliveryIds:[],removalsNextCursor:null,serverTime:time}},2);
 assert.equal(calls,2);
 assert.deepEqual(result.items.map(item=>item.id),['a','b','c']);
});

test('a changed cutoff or repeating cursor aborts instead of committing partial data',async()=>{
 let calls=0;
 await assert.rejects(collectSyncPages<Item>(null,async()=>{calls++;return {items:calls===1?[{id:'a'},{id:'b'}]:[],nextCursor:'b',removedDeliveryIds:[],removalsNextCursor:null,serverTime:calls===1?time:'2026-11-18T12:01:00.000Z'}},2),/janela/);
 await assert.rejects(collectSyncPages<Item>(null,async()=>({items:[{id:'a'},{id:'b'}],nextCursor:'b',removedDeliveryIds:[],removalsNextCursor:null,serverTime:time}),2),/repetida/);
});
