import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export function CourierMap({ couriers }: { couriers: Record<string, unknown>[] }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markers = useRef(new Map<string, L.CircleMarker>());
  const previousPositions = useRef('');
  const focused = useRef<string | null>(null);

  useEffect(() => {
    const element = container.current!;
    const map = L.map(element).setView([-3.75, -38.53], 12);
    mapRef.current = map;
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(element);
    return () => {
      observer.disconnect();
      map.remove();
      markers.current.clear();
      previousPositions.current = '';
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current!;
    const positions: L.LatLngTuple[] = [];
    const visible = new Set<string>();
    for (const courier of couriers) {
      if (courier.latitude == null || courier.longitude == null) continue;
      const position: L.LatLngTuple = [Number(courier.latitude), Number(courier.longitude)];
      if (!position.every(Number.isFinite)) continue;
      const id = String(courier.sharing_id);
      visible.add(id);
      positions.push(position);
      let marker = markers.current.get(id);
      if (!marker) {
        marker = L.circleMarker(position, {
          radius: 9, color: '#fff', weight: 3, fillColor: '#007784', fillOpacity: 1,
        }).addTo(map);
        const label = document.createElement('span');
        label.textContent = String(courier.full_name);
        marker.bindTooltip(label);
        markers.current.set(id, marker);
      } else {
        marker.setLatLng(position);
      }
    }
    for (const [id, marker] of markers.current) {
      if (!visible.has(id)) {
        marker.remove();
        markers.current.delete(id);
      }
    }
    const signature = JSON.stringify(positions);
    if (focused.current && !visible.has(focused.current)) focused.current = null;
    if (!focused.current && positions.length && signature !== previousPositions.current &&
        (!markers.current.size || !previousPositions.current || previousPositions.current === '[]' ||
         positions.some(position => !map.getBounds().pad(-0.1).contains(position)))) {
      map.fitBounds(L.latLngBounds(positions), { padding: [24, 24], maxZoom: 16 });
    }
    previousPositions.current = signature;
  }, [couriers]);

  function focusCourier(id: string) {
    const marker = markers.current.get(id);
    if (!marker || !mapRef.current) return;
    focused.current = id;
    container.current?.scrollIntoView({ block: 'nearest' });
    mapRef.current.flyTo(marker.getLatLng(), 16, {
      animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      duration: 0.7,
    });
    marker.openTooltip();
  }

  return <>
    <div ref={container} className="live-map" style={{ height: 240, zIndex: 0 }}
      role="region" aria-label="Mapa dos entregadores compartilhando localização" />
    {couriers.map(courier => {
      const id = String(courier.sharing_id);
      const name = String(courier.full_name);
      const hasPosition = courier.latitude != null && courier.longitude != null &&
        [courier.latitude, courier.longitude].every(value => Number.isFinite(Number(value)));
      const received = new Date(String(courier.received_at));
      const time = Number.isFinite(received.getTime()) && received.toLocaleString('pt-BR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      return <div className="courier-focus-row" key={id}>
        <div><strong>{name}</strong>
          <small>{hasPosition ? (courier.gps_status === 'stale' ? 'Localização desatualizada' : 'Localização atualizada') : 'Aguardando a primeira localização'}</small>
          {hasPosition && time && <small>Última posição em {time}</small>}
        </div>
        <button type="button" disabled={!hasPosition} aria-label={`Ver ${name} no mapa`}
          onClick={() => focusCourier(id)}>Ver no mapa</button>
      </div>;
    })}
  </>;
}
