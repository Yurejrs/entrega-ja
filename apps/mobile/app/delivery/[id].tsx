import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Image, Linking, Modal, Pressable, ScrollView, StatusBar, StyleSheet, Text, Vibration,
  TextInput, View, useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import { SafeAreaView } from 'react-native-safe-area-context';
import { randomUUID } from 'expo-crypto';
import { deliveries, enqueue, operations, failedOperations } from '../../src/store';
import { localDeliveryPhotos, type LocalDeliveryPhoto } from '../../src/local-photos';
import { flushOperations, syncDeliveries } from '../../src/sync';
import { styles as sharedStyles } from '../index';
import { configuredBaseUrl, request, type DeliveryAddress, type DeliveryPhoto } from '../../src/api';
import { deliveryStatusLabel } from '../../src/status';
import { mapCoordinates, previewTiles } from '../../src/map-tiles';
import { ConfirmModal, Icon } from '../../src/design-system';
import { canComplete } from '../../src/delivery-detail-flow';
import { distanceMeters } from '../../src/geo';

type OperationKind = 'check_in' | 'problem' | 'completion' | 'photo' | 'note';
function VolumeIcon() { return <Icon name="box" size={16}/>; }
type SelectedPhoto = { kind: 'remote'; photo: DeliveryPhoto } | { kind: 'local'; photo: LocalDeliveryPhoto };

function addressParts(address: DeliveryAddress): string[] {
  const street = [address.street, address.number].filter(value => typeof value === 'string' && value.trim()).join(', ');
  const area = [address.complement, address.neighborhood]
    .filter(value => typeof value === 'string' && value.trim()).join(' · ');
  const city = [address.city, address.state].filter(value => typeof value === 'string' && value.trim()).join(' - ');
  const cityAndPostal = [city, address.postal_code].filter(value => typeof value === 'string' && value.trim()).join(' · ');
  return [street, area, cityAndPostal].filter(Boolean);
}

function OSMMapPreview({
  latitude, longitude, width, onOpen,
}: { latitude: number; longitude: number; width: number; onOpen: () => void }) {
  const height = 184;
  const [loadedTiles, setLoadedTiles] = useState(0);
  const [failedTiles, setFailedTiles] = useState(0);
  const tiles = useMemo(() => previewTiles(latitude, longitude, width, height), [latitude, longitude, width]);

  useEffect(() => {
    setLoadedTiles(0);
    setFailedTiles(0);
  }, [latitude, longitude, width]);

  return (
    <Pressable onPress={onOpen} accessibilityRole="button" accessibilityLabel="Prévia do mapa OpenStreetMap. Toque para abrir o mapa">
      <View style={[detailStyles.map, { width, height }]}>
        {tiles.map(tile => <Image
          key={tile.key}
          source={{ uri: tile.url, headers: { 'User-Agent': 'EntregaJa-Android/1.0.0 (map preview)' } }}
          style={{ position: 'absolute', left: tile.left, top: tile.top, width: 256, height: 256 }}
          onLoad={() => setLoadedTiles(count => count + 1)}
          onError={() => setFailedTiles(count => count + 1)}
          fadeDuration={0}
        />)}
        {failedTiles === tiles.length && tiles.length > 0 && <View style={detailStyles.mapError}><Text style={detailStyles.mapErrorText}>Não foi possível carregar o mapa agora.</Text></View>}
        {loadedTiles < tiles.length && failedTiles < tiles.length && <Text style={detailStyles.mapLoading}>Carregando mapa…</Text>}
        <View pointerEvents="none" style={detailStyles.pinHalo}><View style={detailStyles.pin} /></View>
        <Text style={detailStyles.mapAttribution}>© OpenStreetMap contributors</Text>
      </View>
      <Text style={detailStyles.mapLink}>Toque no mapa para ampliar</Text>
    </Pressable>
  );
}

export default function Detail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const item = deliveries().find(delivery => delivery.id === id);
  const { width: viewportWidth } = useWindowDimensions();
  const mapWidth = Math.max(240, Math.min(viewportWidth - 40, 420));
  const [note, setNote] = useState('');
  const [savedNote, setSavedNote] = useState('');
  const [toast, setToast] = useState('');
  const [gpsError, setGpsError] = useState('');
  const [checkInDistanceM, setCheckInDistanceM] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<DeliveryPhoto[]>([]);
  const [photosLoading, setPhotosLoading] = useState(true);
  const [photosError, setPhotosError] = useState('');
  const [mediaBaseUrl, setMediaBaseUrl] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [selectedPhoto, setSelectedPhoto] = useState<SelectedPhoto | null>(null);
  const [geocodedPoint, setGeocodedPoint] = useState<{ latitude: number; longitude: number } | null>(null);
  const [geocoding, setGeocoding] = useState(false);
  const [problemOpen, setProblemOpen] = useState(false);
  const [problemReason, setProblemReason] = useState('');
  const [problemPhotoUri, setProblemPhotoUri] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<'check_in'|'completion'|null>(null);
  const [problemReasons, setProblemReasons] = useState<Array<{ code: string; label: string }>>([
    { code: 'customer_absent', label: 'Cliente ausente' },
    { code: 'address_not_found', label: 'Endereço não encontrado' },
    { code: 'customer_refused', label: 'Cliente recusou' },
    { code: 'other', label: 'Outro' },
  ]);

  const destination = item?.destination_snapshot ?? {};
  const address = addressParts(destination);
  const coords = mapCoordinates(item?.reference_latitude ?? destination.reference_latitude,
    item?.reference_longitude ?? destination.reference_longitude);
  const syncedCheckIn = mapCoordinates(item?.last_check_in_latitude, item?.last_check_in_longitude);
  const localCheckIn = item ? [...operations(), ...failedOperations()]
    .filter(operation => operation.delivery_id === item.id && operation.kind === 'check_in')
    .reverse()
    .map(operation => {
      try {
        const payload = JSON.parse(operation.payload) as { latitude?: unknown; longitude?: unknown };
        return mapCoordinates(payload.latitude, payload.longitude);
      } catch { return null; }
    }).find(point => point !== null) ?? null : null;
  const checkInPoint = localCheckIn ?? syncedCheckIn;
  const addressForMap = address.join(', ');

  useEffect(() => {
    if (!id) return;
    request(`/deliveries/${id}/view`, { method: 'POST' }).catch(() => {});
    configuredBaseUrl().then(setMediaBaseUrl).catch(() => {});
    SecureStore.getItemAsync('session').then(token => setSessionToken(token ?? '')).catch(() => {});
    SecureStore.getItemAsync('problemReasons').then(value => {
      if (!value) return;
      try {
        const reasons = JSON.parse(value) as Array<{ code?: unknown; label?: unknown }>;
        const valid = reasons.filter(reason => typeof reason.code === 'string' && typeof reason.label === 'string') as Array<{ code: string; label: string }>;
        if (valid.length) setProblemReasons(valid);
      } catch { /* mantém os motivos padrão */ }
    }).catch(() => {});
    loadPhotos();
    SecureStore.getItemAsync(`delivery-note:${id}`).then(value => { if (value !== null) { setNote(value); setSavedNote(value); } }).catch(() => {});
  }, [id]);

  useEffect(() => { if (id) SecureStore.setItemAsync(`delivery-note:${id}`, note).catch(() => {}); }, [id, note]);

  useEffect(() => {
    setGeocodedPoint(null);
    if (coords || checkInPoint || !addressForMap) {
      setGeocoding(false);
      return;
    }
    setGeocoding(true);
    const controller = new AbortController();
    const query = `${addressForMap}, Brasil`;
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
    fetch(url, {
      headers: { 'User-Agent': 'EntregaJa-Android/1.0.0 (map preview)' },
      signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(`Nominatim ${response.status}`);
      return response.json() as Promise<Array<{ lat?: string; lon?: string }>>;
    }).then(results => {
      const point = mapCoordinates(results[0]?.lat, results[0]?.lon);
      if (point) setGeocodedPoint(point);
    }).catch(() => {}).finally(() => setGeocoding(false));
    return () => controller.abort();
  }, [item?.id, item?.customer_name, addressForMap, coords?.latitude, coords?.longitude,
    checkInPoint?.latitude, checkInPoint?.longitude]);

  async function loadPhotos() {
    if (!id) return;
    setPhotosLoading(true);
    setPhotosError('');
    try {
      const result = await request<{ items: DeliveryPhoto[]; nextCursor: string | null }>(`/deliveries/${id}/photos?limit=50`);
      setPhotos(result.items);
    } catch (error) {
      setPhotosError((error as Error).message);
    } finally {
      setPhotosLoading(false);
    }
  }

  async function addPhoto() {
    if (!item || busy) return;
    setBusy(true);
    try {
      const image = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (image.canceled || !image.assets[0]) return;
      const photoUri = `${FileSystem.documentDirectory}delivery-photo-${randomUUID()}.jpg`;
      await FileSystem.copyAsync({ from: image.assets[0].uri, to: photoUri });
      enqueue(item.id, 'photo', { photoUri, occurredAt: new Date().toISOString() });
      await flushOperations();
      await loadPhotos();
    } catch { Alert.alert('Foto pendente', 'A foto foi mantida no aparelho e será enviada quando houver conexão.'); }
    finally { setBusy(false); }
  }

  function saveNote() {
    if (!item || !note.trim() || note.trim() === savedNote.trim()) return;
    void queue('note');
  }

  if (!item) return <View style={sharedStyles.page}><Text>Entrega indisponível.</Text></View>;

  const queued = operations().filter(operation => operation.delivery_id === item.id);
  const failed = failedOperations().filter(operation => operation.delivery_id === item.id);
  const localPhotos = localDeliveryPhotos([...queued, ...failed], item.id);
  const hasRequiredCompletionData = canComplete(!!checkInPoint, photos.length + localPhotos.length);
  const active = item.status === 'assigned' || item.status === 'in_progress' || item.status === 'problem';
  const mapPoint = checkInPoint ?? coords ?? geocodedPoint;
  const mapPointLabel = localCheckIn ? 'Local do check-in salvo no aparelho'
    : syncedCheckIn ? 'Local registrado no check-in'
      : coords ? 'Ponto de entrega cadastrado'
        : geocodedPoint ? 'Local aproximado pelo endereço' : '';
  const fullAddress = address.join(', ') || 'Endereço sem detalhes cadastrados';

  async function openMap() {
    const query = mapPoint ? `${mapPoint.latitude},${mapPoint.longitude}` : fullAddress;
    const label = [item!.customer_name, fullAddress].filter(Boolean).join(' - ');
    const url = mapPoint
      ? `geo:${mapPoint.latitude},${mapPoint.longitude}?q=${encodeURIComponent(`${query}(${label})`)}`
      : `geo:0,0?q=${encodeURIComponent(`${fullAddress} (${item!.customer_name})`)}`;
    try {
      await Linking.openURL(url);
    } catch {
      const webUrl = mapPoint
        ? `https://www.openstreetmap.org/?mlat=${mapPoint.latitude}&mlon=${mapPoint.longitude}#map=17/${mapPoint.latitude}/${mapPoint.longitude}`
        : `https://www.openstreetmap.org/search?query=${encodeURIComponent(fullAddress)}`;
      await Linking.openURL(webUrl);
    }
  }

  async function queue(kind: OperationKind) {
    if (!item || busy) return;
    setBusy(true);
    let measuredDistanceM: number | null = null;
    try {
      const selectedReason = problemReasons.find(reason => reason.code === problemReason);
      let payload: Record<string, unknown> = kind === 'problem'
        ? { note: note.trim() || selectedReason?.label || 'Outro', reasonCode: problemReason || 'other' }
        : { occurredAt: new Date().toISOString(), note: note.trim() };
      if (kind === 'check_in') {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== 'granted') throw new Error('Permita acesso à localização para registrar o check-in');
        const position = await Promise.race([
          Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('O GPS demorou mais de 10 segundos.')), 10000)),
        ]);
        if (coords) {
          measuredDistanceM = distanceMeters(position.coords, coords);
          setCheckInDistanceM(measuredDistanceM);
        }
        payload = {
          ...payload,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyM: Math.max(0, position.coords.accuracy ?? 0),
        };
      }
      if (kind === 'completion') {
        const image = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7 });
        if (image.canceled) return;
        const photoUri = `${FileSystem.documentDirectory}proof-${randomUUID()}.jpg`;
        await FileSystem.copyAsync({ from: image.assets[0].uri, to: photoUri });
        payload.photoUri = photoUri;
      }
      if (kind === 'problem' && problemPhotoUri) payload.photoUri = problemPhotoUri;
      const operationId = enqueue(item.id, kind, payload);
      await flushOperations();
      const failed = failedOperations().find(operation => operation.id === operationId);
      if (failed) {
        Alert.alert('Operação não enviada', 'Não foi possível enviar agora. A operação ficou disponível para revisão.');
        return;
      }
      const pending = operations().some(operation => operation.id === operationId);
      if (!pending) await syncDeliveries().catch(() => {});
      const celebrationEnabled = await SecureStore.getItemAsync('celebrationEnabled');
      if (kind === 'completion' && !pending && celebrationEnabled !== 'false') Vibration.vibrate(35);
      if (kind === 'note') { setSavedNote(note); setToast('Observação salva'); setTimeout(() => setToast(''), 4000); }
      const distanceHint = kind === 'check_in' && measuredDistanceM !== null
        ? ` Distância aproximada até o endereço: ${Math.round(measuredDistanceM)} m.` : '';
      Alert.alert(kind === 'completion' && !pending ? 'Entrega concluída' : pending ? 'Salvo no aparelho' : 'Enviado', pending
        ? `A operação será enviada quando houver conexão.${distanceHint}`
        : `A operação foi registrada na API.${distanceHint}`);
      if (kind === 'completion' && !pending) router.back();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Confira os dados e tente novamente.';
      if (message.toLowerCase().includes('gps') || message.toLowerCase().includes('localização')) setGpsError(message);
      else Alert.alert('Não foi possível registrar', message);
    } finally {
      setBusy(false);
    }
  }

  const photoSource = (photo: DeliveryPhoto) => mediaBaseUrl && sessionToken ? {
    uri: `${mediaBaseUrl}/v1/delivery-photos/${photo.id}`,
    headers: { Authorization: `Bearer ${sessionToken}` },
  } : undefined;

  return (
    <>
      <SafeAreaView style={detailStyles.safePage} edges={['top', 'bottom']}>
      <ScrollView style={detailStyles.page} contentContainerStyle={detailStyles.content}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Voltar para minhas entregas" style={detailStyles.back}>
          <Text style={sharedStyles.link}>‹  Minhas entregas</Text>
        </Pressable>

        <View style={detailStyles.header}>
          <Text style={detailStyles.customer}>{item.customer_name}</Text>
          <Text style={detailStyles.status}>{deliveryStatusLabel(item.status)}</Text>
        </View>

        <View style={detailStyles.card}>
          <Text style={detailStyles.sectionTitle}>Local de entrega</Text>
          {destination.label && <Text style={detailStyles.addressLabel}>{destination.label}</Text>}
          {address.length ? address.map((line, index) => <Text style={detailStyles.addressLine} key={`${item.id}-address-${index}`}>{line}</Text>)
            : <Text style={detailStyles.addressHint}>Este endereço ainda não tem dados completos.</Text>}
          {mapPoint
            ? <>
              <Text style={detailStyles.mapPointLabel}>{mapPointLabel}</Text>
              <OSMMapPreview latitude={mapPoint.latitude} longitude={mapPoint.longitude} width={mapWidth} onOpen={openMap} />
            </>
            : <Pressable style={detailStyles.mapPlaceholder} onPress={openMap} accessibilityRole="button">
              <Text style={detailStyles.mapPlaceholderTitle}>{geocoding ? 'Localizando endereço para exibir o mapa…' : 'Prévia do mapa indisponível'}</Text>
              <Text style={detailStyles.mapPlaceholderText}>{geocoding ? 'Localizando o endereço para montar a prévia…' : 'Cadastre as coordenadas deste endereço na Gestão Web para exibir o ponto no mapa.'}</Text>
              <Text style={detailStyles.mapPlaceholderLink}>Abrir busca do endereço no mapa</Text>
            </Pressable>}
          <View style={detailStyles.inlineActions}>
            {active && <Pressable style={detailStyles.smallButton} onPress={() => { if (checkInPoint) setConfirmation('check_in'); else void queue('check_in'); }} disabled={busy} accessibilityRole="button"><Text style={detailStyles.secondaryButtonText}>{checkInPoint ? 'Refazer check-in' : 'Fazer check-in aqui'}</Text></Pressable>}
            <Pressable style={detailStyles.smallButton} onPress={openMap} accessibilityRole="button"><Text style={detailStyles.secondaryButtonText}>Abrir no app de mapas</Text></Pressable>
            {item.customer_phone && <Pressable style={detailStyles.smallButton} onPress={() => Linking.openURL(`tel:${item.customer_phone}`)} accessibilityRole="button"><Text style={detailStyles.secondaryButtonText}>Ligar</Text></Pressable>}
          </View>
          {!!gpsError && <View style={detailStyles.errorBox}><Text style={detailStyles.errorText}>{gpsError}</Text><Pressable onPress={() => { setGpsError(''); void queue('check_in'); }} accessibilityRole="button"><Text style={sharedStyles.link}>Tentar de novo</Text></Pressable></View>}
          {checkInDistanceM !== null && <Text style={detailStyles.distanceHint}>Distância aproximada no último check-in: {Math.round(checkInDistanceM)} m</Text>}
        </View>

        <View style={detailStyles.card}>
          <Text style={detailStyles.sectionTitle}>Volumes</Text>
          {item.items?.length?item.items.map(volume=><View key={volume.id} style={{flexDirection:'row',alignItems:'center',gap:7}}><VolumeIcon/><Text style={detailStyles.infoText}>{volume.quantity}× {volume.name}</Text></View>):<Text style={detailStyles.infoText}>{item.merchandise_description}</Text>}
          {item.instructions && <Text style={detailStyles.infoText}>{item.instructions}</Text>}
          {item.scheduled_for && <>
            <Text style={detailStyles.label}>Previsão</Text>
            <Text style={detailStyles.infoText}>{new Date(item.scheduled_for).toLocaleString('pt-BR')}</Text>
          </>}
          {queued.length > 0 && <Text style={detailStyles.pending}>{queued.length} operação(ões) aguardando envio</Text>}
        </View>

        <View style={detailStyles.card}>
          <View style={detailStyles.sectionHeader}>
            <Text style={detailStyles.sectionTitle}>Fotos ({photos.length + localPhotos.length})</Text>
            <Pressable onPress={addPhoto} disabled={busy} accessibilityRole="button"><Text style={sharedStyles.link}>Adicionar foto</Text></Pressable>
          </View>
          {photosLoading && <Text style={detailStyles.addressHint}>Carregando fotos…</Text>}
          {!!photosError && <View>
            <Text style={detailStyles.addressHint}>Não foi possível carregar as fotos. Confira a conexão e tente novamente.</Text>
            <Pressable onPress={loadPhotos} accessibilityRole="button"><Text style={sharedStyles.link}>Tentar novamente</Text></Pressable>
          </View>}
          {!photosLoading && !photosError && photos.length === 0 && localPhotos.length === 0 && <Text style={detailStyles.addressHint}>Nenhuma foto ainda.</Text>}
          {localPhotos.length + photos.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={detailStyles.photoList}>
            {localPhotos.map(photo => <Pressable key={`local-${photo.id}`} style={detailStyles.photoCard}
              onPress={() => setSelectedPhoto({ kind: 'local', photo })} accessibilityRole="button"
              accessibilityLabel={photo.status === 'pending' ? 'Abrir foto salva no aparelho aguardando sincronização' : 'Abrir foto de operação com falha'}>
              <Image source={{ uri: photo.uri }} style={detailStyles.thumbnail} resizeMode="cover" />
              <Text style={detailStyles.photoDate}>{photo.status === 'pending' ? 'Salva no aparelho · aguardando envio' : 'Não sincronizada · revisar operação'}</Text>
              {photo.capturedAt && <Text style={detailStyles.photoDate}>{new Date(photo.capturedAt).toLocaleString('pt-BR')}</Text>}
            </Pressable>)}
            {photos.map(photo => <Pressable key={`remote-${photo.id}`} style={detailStyles.photoCard}
              onPress={() => setSelectedPhoto({ kind: 'remote', photo })} accessibilityRole="button"
              accessibilityLabel={`Abrir foto de ${new Date(photo.captured_at).toLocaleDateString('pt-BR')}`}>
              {photoSource(photo)
                ? <Image source={photoSource(photo)} style={detailStyles.thumbnail} resizeMode="cover" />
                : <View style={[detailStyles.thumbnail, detailStyles.photoLoading]}><Text style={detailStyles.addressHint}>Abrindo foto…</Text></View>}
              <Text style={detailStyles.photoDate}>{new Date(photo.captured_at).toLocaleString('pt-BR')}</Text>
            </Pressable>)}
          </ScrollView>}
        </View>

        {active && <View style={detailStyles.card}>
          <Text style={detailStyles.sectionTitle}>Observações</Text>
          <Text style={detailStyles.addressHint}>Rascunho salvo automaticamente neste aparelho.</Text>
          <TextInput
            style={detailStyles.noteInput}
            placeholder="Descreva o problema ou observação"
            accessibilityLabel="Observações da entrega"
            multiline
            value={note}
            onChangeText={setNote}
          />
          <View style={detailStyles.inlineActions}><Pressable style={detailStyles.secondaryButton} onPress={saveNote} disabled={!note.trim() || note.trim() === savedNote.trim()}><Text style={detailStyles.secondaryButtonText}>Salvar observação</Text></Pressable><Pressable style={detailStyles.dangerButton} onPress={() => setProblemOpen(true)} disabled={busy}><Text style={detailStyles.dangerButtonText}>Registrar problema</Text></Pressable></View>
        </View>}

        <View style={detailStyles.card}><Text style={detailStyles.sectionTitle}>Para concluir</Text><Text style={detailStyles.infoText}>{checkInPoint ? '✓ Check-in no local' : '○ Check-in no local'}</Text><Text style={detailStyles.infoText}>{photos.length + localPhotos.length > 0 ? '✓ Pelo menos 1 foto enviada' : '○ Pelo menos 1 foto enviada'}</Text></View>
        {!active && <Text style={detailStyles.closedHint}>Esta entrega não permite novas operações.</Text>}
      </ScrollView>
      </SafeAreaView>
      {active && <View style={detailStyles.footer}><Text style={detailStyles.footerHint}>{!hasRequiredCompletionData ? 'Para concluir: faça o check-in e envie 1 foto.' : ''}</Text><Pressable style={[sharedStyles.primaryButton, !hasRequiredCompletionData && detailStyles.disabledButton]} accessibilityRole="button" accessibilityState={{ disabled: !hasRequiredCompletionData }} disabled={!hasRequiredCompletionData || busy} onPress={() => setConfirmation('completion')}><Text style={sharedStyles.primaryButtonText}>Concluir entrega</Text></Pressable></View>}
      {!!toast && <View style={detailStyles.toast}><Text style={detailStyles.toastText}>{toast}</Text></View>}

      <Modal visible={problemOpen} transparent animationType="slide" onRequestClose={() => setProblemOpen(false)}>
        <View style={detailStyles.modalBackdrop}><View style={detailStyles.problemModal}>
          <Text style={detailStyles.sectionTitle}>Registrar problema</Text>
          <Text style={detailStyles.addressHint}>Escolha um motivo rápido e acrescente uma observação se necessário.</Text>
          <View style={detailStyles.reasonGrid}>{problemReasons.map(reason => <Pressable key={reason.code} style={[detailStyles.reasonButton, problemReason === reason.code && detailStyles.reasonButtonSelected]} onPress={() => { setProblemReason(reason.code); setNote(''); }} accessibilityRole="button" accessibilityState={{ selected: problemReason === reason.code }}><Text style={[detailStyles.reasonText, problemReason === reason.code && detailStyles.reasonTextSelected]}>{reason.label}</Text></Pressable>)}</View>
          <TextInput style={detailStyles.noteInput} placeholder="Observação opcional" multiline value={note} onChangeText={setNote} />
          <Pressable style={detailStyles.photoAttach} onPress={async () => { const image = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7 }); if (!image.canceled && image.assets[0]) { const uri = `${FileSystem.documentDirectory}problem-${randomUUID()}.jpg`; await FileSystem.copyAsync({ from: image.assets[0].uri, to: uri }); setProblemPhotoUri(uri); } }}><Text style={detailStyles.secondaryButtonText}>{problemPhotoUri ? 'Foto anexada' : 'Adicionar foto (opcional)'}</Text></Pressable>
          <View style={detailStyles.modalActions}><Pressable style={detailStyles.secondaryButton} onPress={() => setProblemOpen(false)}><Text style={detailStyles.secondaryButtonText}>Cancelar</Text></Pressable><Pressable style={sharedStyles.primaryButton} disabled={!problemReason || busy} onPress={() => { setProblemOpen(false); void queue('problem'); }}><Text style={sharedStyles.primaryButtonText}>{busy ? 'Salvando…' : 'Registrar'}</Text></Pressable></View>
        </View></View>
      </Modal>

      <Modal visible={!!selectedPhoto} transparent animationType="fade" onRequestClose={() => setSelectedPhoto(null)}>
        <StatusBar barStyle={selectedPhoto ? 'light-content' : 'dark-content'} backgroundColor={selectedPhoto ? '#07171D' : '#F4F7F8'} />
        <SafeAreaView style={detailStyles.photoModalSafe} edges={['top', 'bottom']}>
        <View style={detailStyles.photoModal}>
          <Pressable style={detailStyles.photoClose} onPress={() => setSelectedPhoto(null)} accessibilityRole="button" accessibilityLabel="Fechar foto">
            <Text style={detailStyles.photoCloseText}>Fechar</Text>
          </Pressable>
          {selectedPhoto?.kind === 'remote' && photoSource(selectedPhoto.photo) && <Image source={photoSource(selectedPhoto.photo)} style={detailStyles.fullPhoto} resizeMode="contain" />}
          {selectedPhoto?.kind === 'local' && <Image source={{ uri: selectedPhoto.photo.uri }} style={detailStyles.fullPhoto} resizeMode="contain" />}
          {selectedPhoto?.kind === 'remote' && <Text style={detailStyles.fullPhotoDate}>{new Date(selectedPhoto.photo.captured_at).toLocaleString('pt-BR')}</Text>}
          {selectedPhoto?.kind === 'local' && <Text style={detailStyles.fullPhotoDate}>{selectedPhoto.photo.status === 'pending' ? 'Salva no aparelho · aguardando envio' : 'Operação não sincronizada'}{selectedPhoto.photo.capturedAt ? ` · ${new Date(selectedPhoto.photo.capturedAt).toLocaleString('pt-BR')}` : ''}</Text>}
        </View>
        </SafeAreaView>
      </Modal>
      <ConfirmModal visible={confirmation !== null} title={confirmation === 'completion' ? 'Concluir entrega?' : 'Refazer check-in?'} message={confirmation === 'completion' ? 'Depois da confirmação, a entrega será finalizada.' : 'O novo ponto substituirá o ponto salvo neste endereço.'} confirmLabel={confirmation === 'completion' ? 'Concluir' : 'Continuar'} destructive={confirmation === 'completion'} onCancel={() => setConfirmation(null)} onConfirm={() => { const action = confirmation; setConfirmation(null); if (action) void queue(action); }}/>
    </>
  );
}

const detailStyles = StyleSheet.create({
  safePage: { flex: 1, backgroundColor: '#F4F7F8' },
  page: { flex: 1, backgroundColor: '#F4F7F8' },
  content: { padding: 20, paddingBottom: 36, gap: 12 },
  inlineActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  smallButton: { minHeight: 44, borderWidth: 1, borderColor: '#C5D2D7', borderRadius: 12, paddingHorizontal: 12, justifyContent: 'center' },
  errorBox: { backgroundColor: '#FFF3D6', borderRadius: 12, padding: 10, gap: 5 },
  errorText: { fontFamily: 'Inter_400Regular', color: '#5A4200', lineHeight: 18 },
  back: { alignSelf: 'flex-start', marginBottom: 2 },
  header: { gap: 8, marginBottom: 4 },
  customer: { fontFamily: 'Inter_600SemiBold', fontSize: 25, lineHeight: 32, color: '#12202A' },
  status: { alignSelf: 'flex-start', fontFamily: 'Inter_600SemiBold', color: '#0F4C5C', backgroundColor: '#D9E8EB', overflow: 'hidden', borderRadius: 18, paddingHorizontal: 12, paddingVertical: 6 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 14, padding: 16, gap: 8 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  sectionTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 17, color: '#12202A', marginBottom: 2 },
  addressLabel: { fontFamily: 'Inter_500Medium', fontSize: 14, color: '#6B7C87' },
  addressLine: { fontFamily: 'Inter_500Medium', fontSize: 15, lineHeight: 22, color: '#263C46' },
  addressHint: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 19, color: '#6B7C87' },
  label: { fontFamily: 'Inter_500Medium', fontSize: 12, color: '#6B7C87', marginTop: 6 },
  infoText: { fontFamily: 'Inter_400Regular', fontSize: 15, lineHeight: 21, color: '#263C46' },
  map: { position: 'relative', alignSelf: 'center', overflow: 'hidden', borderRadius: 12, backgroundColor: '#DDE9E7', marginTop: 8 },
  pinHalo: { position: 'absolute', left: '50%', top: '50%', width: 34, height: 34, marginLeft: -17, marginTop: -17, borderRadius: 20, backgroundColor: '#0F4C5C44', alignItems: 'center', justifyContent: 'center' },
  pin: { width: 16, height: 16, borderRadius: 10, backgroundColor: '#B3433B', borderWidth: 3, borderColor: '#FFFFFF' },
  mapAttribution: { position: 'absolute', right: 4, bottom: 3, backgroundColor: '#FFFFFFDD', color: '#263C46', fontFamily: 'Inter_400Regular', fontSize: 9, paddingHorizontal: 4, paddingVertical: 2, borderRadius: 3 },
  mapLoading: { position: 'absolute', left: 8, top: 8, backgroundColor: '#FFFFFFDD', color: '#263C46', fontFamily: 'Inter_500Medium', fontSize: 11, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 5 },
  mapPointLabel: { fontFamily: 'Inter_500Medium', color: '#6B7C87', fontSize: 12, marginTop: 8 },
  distanceHint: { fontFamily: 'Inter_500Medium', color: '#0F4C5C', fontSize: 13, marginTop: 8 },
  mapError: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F4F7F8CC' },
  mapErrorText: { fontFamily: 'Inter_500Medium', color: '#263C46', backgroundColor: '#FFFFFFDD', padding: 10, borderRadius: 8 },
  mapLink: { fontFamily: 'Inter_500Medium', color: '#0F4C5C', textAlign: 'center', marginTop: 5, marginBottom: 3 },
  mapPlaceholder: { backgroundColor: '#EEF4F5', borderRadius: 12, minHeight: 128, padding: 16, justifyContent: 'center', gap: 7, marginTop: 8 },
  mapPlaceholderTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 15, color: '#263C46' },
  mapPlaceholderText: { fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 19, color: '#6B7C87' },
  mapPlaceholderLink: { fontFamily: 'Inter_600SemiBold', color: '#0F4C5C', marginTop: 3 },
  secondaryButton: { borderWidth: 1, borderColor: '#B8C3CA', borderRadius: 9, alignItems: 'center', padding: 12, marginTop: 5 },
  secondaryButtonText: { fontFamily: 'Inter_600SemiBold', color: '#0F4C5C' },
  phoneButton: { borderRadius: 9, alignItems: 'center', padding: 12, backgroundColor: '#EEF4F5' },
  phoneButtonText: { fontFamily: 'Inter_600SemiBold', color: '#0F4C5C' },
  dangerButton: { minHeight: 48, borderWidth: 1, borderColor: '#D9A3A3', borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  dangerButtonText: { fontFamily: 'Inter_600SemiBold', color: '#8A1C1C' },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#FFFFFF', borderTopWidth: 1, borderTopColor: '#DDE5E8', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10, gap: 5 },
  footerHint: { fontFamily: 'Inter_400Regular', color: '#46565E', fontSize: 12, minHeight: 16 },
  disabledButton: { opacity: 0.45 },
  toast: { position: 'absolute', left: 20, right: 20, bottom: 92, backgroundColor: '#0B4F2E', borderRadius: 12, padding: 12, alignItems: 'center' },
  toastText: { color: '#FFFFFF', fontFamily: 'Inter_600SemiBold' },
  pending: { fontFamily: 'Inter_500Medium', color: '#C8641E', marginTop: 8 },
  photoList: { gap: 12, paddingVertical: 4, paddingRight: 8 },
  photoCard: { width: 172, gap: 6 },
  thumbnail: { width: 172, height: 128, borderRadius: 10, backgroundColor: '#E6EEF1' },
  photoLoading: { alignItems: 'center', justifyContent: 'center' },
  photoDate: { fontFamily: 'Inter_400Regular', color: '#6B7C87', fontSize: 11 },
  noteInput: { fontFamily: 'Inter_400Regular', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#B8C3CA', borderRadius: 9, padding: 12, minHeight: 92, textAlignVertical: 'top', color: '#12202A' },
  closedHint: { fontFamily: 'Inter_400Regular', textAlign: 'center', color: '#6B7C87', marginVertical: 6 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#072A3588' },
  problemModal: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, gap: 12 },
  reasonGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  reasonButton: { minHeight: 48, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: '#B8C3CA', justifyContent: 'center' },
  reasonButtonSelected: { backgroundColor: '#EEF4F5', borderColor: '#0F4C5C' },
  reasonText: { fontFamily: 'Inter_500Medium', color: '#263C46', fontSize: 13 },
  reasonTextSelected: { fontFamily: 'Inter_600SemiBold', color: '#0F4C5C' },
  modalActions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end' },
  photoAttach: { minHeight: 48, borderWidth: 1, borderColor: '#B8C3CA', borderRadius: 9, alignItems: 'center', justifyContent: 'center', padding: 12 },
  photoModal: { flex: 1, backgroundColor: '#07171D', justifyContent: 'center', alignItems: 'center', padding: 16 },
  photoModalSafe: { flex: 1, backgroundColor: '#07171D' },
  photoClose: { position: 'absolute', top: 8, right: 18, zIndex: 2, padding: 10, backgroundColor: '#FFFFFF20', borderRadius: 8 },
  photoCloseText: { fontFamily: 'Inter_600SemiBold', color: '#FFFFFF' },
  fullPhoto: { width: '100%', height: '80%' },
  fullPhotoDate: { fontFamily: 'Inter_400Regular', color: '#FFFFFF', marginTop: 14 },
});
