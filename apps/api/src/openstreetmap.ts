export type Locality = { sourceElement:string; category:'street'|'neighborhood'|'locality'; name:string; latitude:number|null; longitude:number|null };
export function parseOverpass(elements:unknown[]):Locality[]{
  const found=new Map<string,Locality>();
  for(const raw of elements){if(!raw||typeof raw!=='object')continue;const e=raw as Record<string,any>;const tags=e.tags??{};const name=String(tags.name??'').trim();if(!name)continue;
    let category:Locality['category']|null=null;
    if(e.type==='way'&&tags.highway)category='street';
    else if(['neighbourhood','suburb','quarter','borough'].includes(tags.place))category='neighborhood';
    else if(['village','town','city','hamlet','municipality'].includes(tags.place))category='locality';
    if(!category)continue;const lat=Number(e.lat??e.center?.lat),lon=Number(e.lon??e.center?.lon);
    const value={sourceElement:`${e.type}/${e.id}`,category,name,latitude:Number.isFinite(lat)?lat:null,longitude:Number.isFinite(lon)?lon:null} as Locality;
    const key=`${category}:${name.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()}`;if(!found.has(key))found.set(key,value);
  }
  return [...found.values()].sort((a,b)=>a.category.localeCompare(b.category)||a.name.localeCompare(b.name,'pt-BR'));
}
// The map API returns ways as node references. Keep a point inside the requested radius.
export async function nearbyMapPlaces(lat: number, lon: number, radius: number) {
  const dy = radius / 111195;
  const dx = dy / Math.cos(lat * Math.PI / 180);
  const bbox = [lon-dx, lat-dy, lon+dx, lat+dy].join(',');
  const response = await fetch('https://api.openstreetmap.org/api/0.6/map.json?bbox=' + bbox, {
    signal: AbortSignal.timeout(18000), headers: { 'User-Agent': 'EntregaJa/1.0 (locality catalog)' },
  });
  if (!response.ok) throw new Error('Mapa indisponível');
  type Element = {id:number;type:string;lat?:number;lon?:number;nodes?:number[];tags?:{name?:string}};
  const { elements } = await response.json() as {elements:Element[]};
  const nearby = new Map<number, {lat:number;lon:number}>();
  for (const e of elements) {
    if (e.type === 'node' && e.lat != null && e.lon != null &&
        Math.hypot((e.lat-lat)/dy, (e.lon-lon)/dx) <= 1) nearby.set(e.id, {lat:e.lat,lon:e.lon});
  }
  const located = [];
  for (const e of elements) {
    if (!e.tags?.name) continue;
    const id = e.type === 'way' ? e.nodes?.find(node => nearby.has(node)) : e.type === 'node' ? e.id : undefined;
    const point = id === undefined ? undefined : nearby.get(id);
    if (point) located.push({...e, ...point});
  }
  return parseOverpass(located);
}
