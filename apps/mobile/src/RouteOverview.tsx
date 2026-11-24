import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { request, type Delivery, type DeliveryAddress } from './api';
import { cacheRouteOverview, failedOperations, getMeta, operations } from './store';
import { brand } from './brand';

type Stop = {id:string; customer:string; address:DeliveryAddress; status:string; delivery_status:string; checked:boolean};
type Overview = {id:string; status:string; stops:Stop[]};

export function seedRouteOverview(id:string, orderedIds:string[], items:Delivery[]) {
  const stops:Stop[] = [];
  for (const deliveryId of orderedIds) {
    const item = items.find(delivery => delivery.id === deliveryId);
    if (item) stops.push({id:item.id,customer:item.customer_name,address:item.destination_snapshot,
      status:'pending',delivery_status:item.status,checked:item.last_check_in_latitude != null});
  }
  cacheRouteOverview(JSON.stringify({id,status:'active',stops}));
}

export function RouteOverview({id,items}:{id:string;items:Delivery[]}) {
  const [route,setRoute] = useState<Overview|null>(() => {
    const cached = JSON.parse(getMeta('routeOverview') ?? 'null') as Overview|null;
    return cached?.id === id ? cached : null;
  });
  const [offline,setOffline] = useState(false);
  useFocusEffect(useCallback(() => {
    let current = true, loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const next = await request<Overview>(`/mobile/routes/${id}?include=stops`);
        if (current && Array.isArray(next.stops)) {
          cacheRouteOverview(JSON.stringify(next));
          setRoute(next);
          setOffline(false);
        }
      } catch { if (current) setOffline(true); }
      finally { loading = false; }
    }
    void load();
    const timer = setInterval(load,15000);
    return () => {current=false;clearInterval(timer);};
  },[id]));

  const pending = operations(), failed = failedOperations();
  const remaining = route?.stops.filter(stop => stop.status !== 'completed') ?? [];
  return <View style={s.card}>
    <Text accessibilityRole="header" style={s.title}>{route?.status === 'completed' ? 'Rota concluída' : route?.status === 'cancelled' ? 'Rota cancelada' : 'Minha rota'}</Text>
    {route && <Text>{route.stops.length - remaining.length} de {route.stops.length} entregas concluídas</Text>}
    {offline && <Text>Sem atualização. Exibindo os dados disponíveis no aparelho.</Text>}
    {!offline && !route && <Text>Carregando paradas…</Text>}
    {remaining.map((stop,index) => {
      const item = items.find(d => d.id === stop.id);
      const queued = pending.filter(op => op.delivery_id === stop.id);
      const review = failed.some(op => op.delivery_id === stop.id);
      const label = review ? 'Operação para revisar' : queued.some(op=>op.kind==='completion') ? 'Conclusão aguardando envio'
        : queued.some(op=>op.kind==='check_in') ? 'Check-in aguardando envio'
        : stop.delivery_status === 'problem' ? 'Problema registrado'
        : stop.checked || item?.last_check_in_latitude != null ? 'Check-in realizado' : 'Aguardando check-in';
      const address = stop.address ?? {};
      const position = (route?.stops.indexOf(stop) ?? index) + 1;
      const attention = review || stop.delivery_status === 'problem';
      const accent = attention ? '#963C20' : index === 0 ? '#095C60' : '#526478';
      return <Pressable key={stop.id} accessibilityRole="button" style={[s.stop,{borderLeftColor:accent,backgroundColor:attention?'#FFF3EB':index===0?'#E6F4F1':'#F3F5F8'}]}
        onPress={()=>router.push({pathname:'/delivery/[id]',params:{id:stop.id}})}>
        <Text style={[s.label,{color:accent}]}>Parada {position} · {index === 0 ? 'Próxima parada' : 'A seguir'}{attention ? ' · Requer atenção' : ''}</Text>
        <Text style={s.name}>{stop.customer}</Text>
        <Text>{[address.street,address.number,address.neighborhood,address.city].filter(Boolean).join(', ')}</Text>
        <Text style={s.label}>{label}</Text>
      </Pressable>;
    })}
  </View>;
}
const s = StyleSheet.create({
  card:{backgroundColor:'white',padding:16,borderRadius:14,gap:6,borderWidth:1,borderColor:brand.border},
  title:{fontSize:18,fontWeight:'600',color:brand.text},
  stop:{padding:14,borderLeftWidth:5,borderRadius:10,gap:5,marginTop:6},
  name:{fontSize:20,fontWeight:'700',color:brand.text},
  label:{fontSize:13,color:brand.petroleum},
});
