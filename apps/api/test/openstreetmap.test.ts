import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOverpass } from '../src/openstreetmap.js';

test('parseOverpass stores named streets and nearby places with normalized deduplication', () => {
  const result = parseOverpass([
    { type:'way', id:1, tags:{ highway:'residential', name:'Rua São José' }, center:{lat:'-3.73',lon:'-38.52'} },
    { type:'way', id:2, tags:{ highway:'service', name:'Rua Sao Jose' }, center:{lat:-3.74,lon:-38.53} },
    { type:'node', id:3, lat:-3.72, lon:-38.51, tags:{ place:'neighbourhood', name:'Centro' } },
    { type:'relation', id:4, tags:{ place:'city', name:'Fortaleza' } },
    { type:'node', id:5, tags:{ place:'farm', name:'Ignore' } },
    { type:'way', id:6, tags:{ highway:'residential' } },
  ]);

  assert.deepEqual(Object.fromEntries(result.map(item=>[item.sourceElement,{category:item.category,name:item.name}])),{
    'relation/4':{category:'locality',name:'Fortaleza'},
    'node/3':{category:'neighborhood',name:'Centro'},
    'way/1':{category:'street',name:'Rua São José'},
  });
  assert.equal(result.find(item=>item.sourceElement==='way/1')?.latitude,-3.73);
  assert.equal(result.find(item=>item.sourceElement==='way/1')?.longitude,-38.52);
});

test('parseOverpass retains a named place without coordinates', () => {
  assert.deepEqual(parseOverpass([{type:'node',id:8,tags:{place:'village',name:'Vila Nova'}}]),[
    {sourceElement:'node/8',category:'locality',name:'Vila Nova',latitude:null,longitude:null},
  ]);
});
