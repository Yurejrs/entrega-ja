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
