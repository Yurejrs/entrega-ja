import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, AppState, FlatList, Image, Linking, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Polygon, Rect, Stop } from 'react-native-svg';
import { router, useFocusEffect } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  signIn, signOut, defaultBaseUrl, configuredBaseUrl, setBaseUrl, request,
  type CourierProfile, type Delivery, type Productivity, type SeasonalAward, type SeasonalCourier,
} from '../src/api';
import { deliveries, reset, prepareAccount, failedOperations, operations, retryFailed } from '../src/store';
import { syncDeliveries, flushOperations, discardFailedOperations } from '../src/sync';
import { registerDevice, unregisterDevice, onNotification } from '../src/notifications';
import { Logo, brand } from '../src/brand';
import { deliveryStatusLabel } from '../src/status';
import { accountKey } from '../src/account-key';
import { startRouteTracking } from '../src/route-tracking';
import { resumeRouteTracking } from '../src/route-tracking';
import { toggleRouteSelection } from '../src/route-selection';
import { EmptyState, Icon, ProgressRing, StatusChip } from '../src/design-system';

type MainTab = 'ritmo' | 'deliveries' | 'profile' | 'settings';
type DeliveryTab = 'open' | 'finished' | 'available';
type Period = 'day' | 'week' | 'month';
type DeliveryRow = Delivery & { groupedDeliveries?: Delivery[] };
const TIME_ZONE = 'America/Fortaleza';
function VolumeIcon({ color = brand.petroleum }: { color?: string }) { return <Icon name="box" color={color} size={16}/>; }
function formatMoney(cents: number): string { return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
const tabTitles: Record<MainTab, string> = {
  ritmo: 'Ritmo', deliveries: 'Entregas', profile: 'Perfil', settings: 'Configurações',
};

function userFacingError(error: unknown, fallback: string): string {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: number }).status) : 0;
  if (status === 401) return 'Sua sessão expirou. Entre novamente para continuar.';
  if (status === 409) return 'Essa entrega mudou enquanto você estava trabalhando. Atualize e tente novamente.';
  if (status === 0) return 'Não foi possível conectar agora. Tente novamente em instantes.';
  return fallback;
}

function dayKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function shiftDay(day: string, amount: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dayAtNoon(day: string): Date { return new Date(`${day}T12:00:00-03:00`); }

function dateLabel(day: string): string {
  return dayAtNoon(day).toLocaleDateString('pt-BR', {
    timeZone: TIME_ZONE, weekday: 'short', day: '2-digit', month: 'long', year: 'numeric',
  });
}

function monthLabel(month: string): string {
  return new Date(`${month}-01T12:00:00-03:00`).toLocaleDateString('pt-BR', {
    timeZone: TIME_ZONE, month: 'long', year: 'numeric',
  });
}

function monthDays(month: string): Array<string | null> {
  const [year, monthNumber] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year!, monthNumber! - 1, 1));
  const offset = first.getUTCDay();
  const count = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate();
  return [...Array<string | null>(offset).fill(null), ...Array.from({ length: count }, (_, index) =>
    `${month}-${String(index + 1).padStart(2, '0')}`)];
}

function startOfWeek(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
  return date.toISOString().slice(0, 10);
}

function hourAtFortaleza(value: string): number {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(value)));
}

function localProductivity(items: Delivery[], period: Period): Productivity {
  const done = items.filter(item => item.status === 'completed' && item.completed_at);
  const today = dayKey(new Date());
  const weekStart = startOfWeek(today);
  const monthStart = `${today.slice(0, 7)}-01`;
  const summary = {
    day: done.filter(item => dayKey(item.completed_at!) === today).length,
    week: done.filter(item => dayKey(item.completed_at!) >= weekStart && dayKey(item.completed_at!) <= today).length,
    month: done.filter(item => dayKey(item.completed_at!).startsWith(today.slice(0, 7))).length,
  };

  let buckets: Array<{ key: string; label: string }>;
  if (period === 'day') {
    buckets = Array.from({ length: 24 }, (_, hour) => ({
      key: `${today}-${String(hour).padStart(2, '0')}`,
      label: `${String(hour).padStart(2, '0')}h`,
    }));
  } else if (period === 'week') {
    buckets = Array.from({ length: 7 }, (_, index) => {
      const key = shiftDay(weekStart, index);
      return { key, label: dayAtNoon(key).toLocaleDateString('pt-BR', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit' }) };
    });
  } else {
    const count = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
    buckets = Array.from({ length: count }, (_, index) => {
      const key = `${today.slice(0, 7)}-${String(index + 1).padStart(2, '0')}`;
      return { key, label: String(index + 1).padStart(2, '0') };
    });
  }
  const series = buckets.map(bucket => ({
    label: bucket.label,
    count: done.filter(item => period === 'day'
      ? dayKey(item.completed_at!) === today && hourAtFortaleza(item.completed_at!) === Number(bucket.key.slice(-2))
      : dayKey(item.completed_at!) === bucket.key).length,
  }));
  return { summary, lifetime: done.length, period, items: series };
}

function shortAddress(delivery: Delivery): string[] {
  const address = delivery.destination_snapshot ?? {};
  const street = [address.street, address.number].filter(Boolean).join(', ');
  const area = [address.neighborhood, [address.city, address.state].filter(Boolean).join(' - ')]
    .filter(Boolean).join(' · ');
  return [street, area].filter(Boolean);
}

function AppIcon({ tab, color }: { tab: MainTab; color: string }) {
  const common = { fill: 'none' as const, stroke: color, strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return <Svg width={23} height={23} viewBox="0 0 24 24" accessibilityElementsHidden>
    {tab === 'ritmo' && <><Path {...common} d="M4 19V9m5 10V5m5 14v-7m5 7V3"/><Path {...common} d="M2.5 20.5h19"/></>}
    {tab === 'deliveries' && <><Path {...common} d="M4 5.5h16v14H4z"/><Path {...common} d="M8 3.5v4m8-4v4M4 9.5h16M8 14h3m2 0h3m-8 3h3"/></>}
    {tab === 'profile' && <><Circle {...common} cx={12} cy={8} r={3.5}/><Path {...common} d="M4 20c.7-3.6 3.6-5.5 8-5.5s7.3 1.9 8 5.5"/></>}
    {tab === 'settings' && <><Path {...common} d="M12 8.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Z"/><Path {...common} d="m19.4 13.5 1.1.9-1.3 2.3-1.4-.5a7.6 7.6 0 0 1-1.4.8l-.2 1.5h-2.6l-.3-1.5a7.5 7.5 0 0 1-1.4-.8l-1.4.5-1.3-2.3 1.1-.9a6.5 6.5 0 0 1 0-1.6l-1.1-.9 1.3-2.3 1.4.5a7.6 7.6 0 0 1 1.4-.8l.3-1.5h2.6l.2 1.5a7.5 7.5 0 0 1 1.4.8l1.4-.5 1.3 2.3-1.1.9a6.5 6.5 0 0 1 0 1.6Z"/></>}
  </Svg>;
}

function SeasonalMedalIcon({gem,unlocked,size=66}:{gem:'ruby'|'emerald';unlocked:boolean;size?:number}){
  const metalId=`${gem}-medal-metal`,gemId=`${gem}-medal-gem`;
  const metal=unlocked?['#68430E','#FFE9A0','#B7801E','#FFF0B8','#765014']:['#59666B','#F4F6F6','#9AA7AB','#E4E9EA','#5D696D'];
  const jewel=unlocked?(gem==='ruby'?['#4A071C','#F34264','#A80E35','#FF9BAE']:['#063D35','#26BA83','#087052','#83F0BE']):['#475156','#CAD1D3','#889499','#DCE1E2'];
  const shadow=unlocked?(gem==='ruby'?'#49051A':'#063C32'):'#59666B';
  return <Svg width={size} height={size*1.12} viewBox="0 0 88 99">
    <Defs>
      <LinearGradient id={metalId} x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor={metal[0]}/><Stop offset="0.24" stopColor={metal[1]}/><Stop offset="0.5" stopColor={metal[2]}/><Stop offset="0.73" stopColor={metal[3]}/><Stop offset="1" stopColor={metal[4]}/></LinearGradient>
      <LinearGradient id={gemId} x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor={jewel[0]}/><Stop offset="0.42" stopColor={jewel[1]}/><Stop offset="0.73" stopColor={jewel[2]}/><Stop offset="1" stopColor={jewel[3]}/></LinearGradient>
    </Defs>
    <Path d="M26 53 43 62 32 94 18 86Z" fill={`url(#${metalId})`} stroke={metal[4]} strokeWidth="1.2"/>
    <Path d="m62 53-17 9 11 32 14-8Z" fill={`url(#${metalId})`} stroke={metal[4]} strokeWidth="1.2"/>
    <Path d="m24 58 10 6-10 21-7-4Z" fill={metal[1]} opacity=".76"/>
    <Path d="m64 58-10 6 10 21 7-4Z" fill={metal[2]} opacity=".78"/>
    <Circle cx="44" cy="38" r="33" fill={`url(#${metalId})`} stroke={metal[4]} strokeWidth="1.4"/>
    <Circle cx="44" cy="38" r="27" fill={shadow} stroke={metal[1]} strokeWidth="1.5"/>
    <Circle cx="44" cy="38" r="23.5" fill="none" stroke={metal[2]} strokeWidth=".8"/>
    <Polygon points="44,15 61,29 55,52 33,52 27,29" fill={`url(#${gemId})`} stroke={metal[1]} strokeWidth="1.4"/>
    <Polygon points="44,15 44,34 27,29" fill={jewel[3]} opacity=".78"/>
    <Polygon points="44,15 61,29 44,34" fill={jewel[1]} opacity=".88"/>
    <Polygon points="27,29 44,34 33,52" fill={jewel[0]} opacity=".92"/>
    <Polygon points="61,29 44,34 55,52" fill={jewel[2]} opacity=".92"/>
    <Polygon points="33,52 44,34 55,52" fill={jewel[1]} opacity=".75"/>
    <Path d="m34 18 4-2m16 2-4-2" stroke="#FFF5D1" strokeWidth="1.4" strokeLinecap="round" opacity={unlocked?0.85:0.35}/>
    <Circle cx="44" cy="72" r="3.1" fill={`url(#${metalId})`} stroke={metal[1]} strokeWidth=".7"/>
  </Svg>;
}

function SeasonalAwardCard({title,gem,period,award}:{title:string;gem:'ruby'|'emerald';period:'week'|'month';award?:SeasonalAward}){
  const today=dayKey(new Date());
  const expectedPeriodStart=period==='week'?startOfWeek(today):`${today.slice(0,7)}-01`;
  const current=award?.periodStart===expectedPeriodStart;
  const unlocked=!!current&&award?.awarded===true;
  const score=current&&award?award.completed:0,rank=current&&award?award.rank:null,resetAt=current&&award?award.resetAt:null;
  const summary=!current?'Sincronize para consultar esta temporada':unlocked?`Você lidera com ${score} ${score===1?'entrega':'entregas'}`:
    score===0?'Conclua entregas para entrar na disputa':rank?`${rank}º lugar · ${score} ${score===1?'entrega':'entregas'}`:'Temporada em andamento';
  const resetLabel=resetAt?`Reinicia ${new Date(resetAt).toLocaleDateString('pt-BR',{timeZone:TIME_ZONE,day:'2-digit',month:'2-digit'})}`:'Aguardando atualização';
  return <View style={[styles.seasonalAwardCard,unlocked&&styles.seasonalAwardCardWon]}>
    <SeasonalMedalIcon gem={gem} unlocked={unlocked}/>
    <View style={styles.seasonalAwardText}><Text style={styles.seasonalAwardTitle}>{title}</Text>
      <Text style={[styles.seasonalAwardStatus,unlocked&&styles.seasonalAwardStatusWon]}>{unlocked?'Líder da temporada':current?'Em disputa':'Temporada atual'}</Text>
      <Text style={styles.seasonalAwardSummary}>{summary}</Text><Text style={styles.seasonalAwardReset}>{resetLabel}</Text>
    </View>
  </View>;
}

function TeamSeasonalRank({couriers,period,myId}:{couriers:SeasonalCourier[];period:'week'|'month';myId?:string|null}){
  const week=period==='week';
  const ordered=[...couriers].sort((a,b)=>((week?b.weekCompleted:b.monthCompleted)-(week?a.weekCompleted:a.monthCompleted))||a.name.localeCompare(b.name,'pt-BR'));
  const top=ordered[0]?(week?ordered[0].weekCompleted:ordered[0].monthCompleted):0;
  return <View style={styles.teamRankCard}>
    <View style={styles.teamRankHeading}><View><Text style={styles.sectionTitle}>Ranking da temporada</Text><Text style={styles.meta}>{week?'Esta semana':'Este mês'} · entregas concluídas</Text></View><SeasonalMedalIcon gem={week?'ruby':'emerald'} unlocked={top>0} size={39}/></View>
    {ordered.length===0?<Text style={styles.teamRankEmpty}>Os entregadores ativos aparecerão aqui.</Text>:ordered.map(courier=>{
      const count=week?courier.weekCompleted:courier.monthCompleted, winner=week?courier.weekWinner:courier.monthWinner, me=courier.membershipId===myId;
      const rank=week?courier.weekRank:courier.monthRank;
      const imageUri=courier.photoUri;
      return <View key={courier.membershipId} style={[styles.teamRankRow,me&&styles.teamRankRowMe]}>
        <View style={styles.teamRankPosition}>{rank===1?<Icon name="check" color="#A67717" size={17}/>:<Text style={[styles.teamRankPositionText,rank===1&&styles.teamRankPositionFirst]}>{rank?`${rank}`:'—'}</Text>}</View>
        <RankAvatar uri={imageUri} name={courier.name}/>
        <View style={styles.teamRankInfo}><Text style={styles.teamRankName} numberOfLines={1}>{courier.name}{me?' · você':''}</Text><Text style={styles.teamRankDeliveries}>{count} {count===1?'entrega':'entregas'}</Text></View>
        {winner&&<SeasonalMedalIcon gem={week?'ruby':'emerald'} unlocked size={36}/>}
      </View>;
    })}
    <Text style={styles.teamRankFootnote}>A contagem reinicia na virada {week?'da semana':'do mês'}.</Text>
  </View>;
}

function UnifiedSeasonalRank({ couriers, myId }: { couriers: SeasonalCourier[]; myId?: string | null }) {
  const [period, setPeriod] = useState<'week'|'month'>('week');
  const ordered = [...couriers].sort((a,b) => (period === 'week' ? b.weekCompleted-a.weekCompleted : b.monthCompleted-a.monthCompleted) || a.name.localeCompare(b.name,'pt-BR'));
  const me = ordered.find(c => c.membershipId === myId);
  const position = period === 'week' ? me?.weekRank : me?.monthRank;
  const leader = ordered[0];
  const myCount = period === 'week' ? me?.weekCompleted ?? 0 : me?.monthCompleted ?? 0;
  const leaderCount = period === 'week' ? leader?.weekCompleted ?? 0 : leader?.monthCompleted ?? 0;
  const encouragement = position && position > 1 ? `Faltam ${Math.max(1, leaderCount - myCount)} entregas para alcançar o 1º lugar.` : position === 1 ? 'Você está em 1º lugar. Continue assim!' : 'Conclua uma entrega para entrar no ranking.';
  return <View style={styles.teamRankCard}><View style={styles.teamRankHeading}><View><Text style={styles.sectionTitle}>Ranking</Text><Text style={styles.meta}>{period === 'week' ? 'Esta semana' : 'Este mês'} · entregas concluídas</Text></View><View style={styles.periodSwitch}>{(['week','month'] as const).map(option => <Pressable key={option} onPress={() => setPeriod(option)} style={[styles.periodButton,period===option&&styles.periodButtonActive]}><Text style={[styles.periodText,period===option&&styles.periodTextActive]}>{option==='week'?'Semana':'Mês'}</Text></Pressable>)}</View></View>{ordered.slice(0,3).map((courier,index) => <View key={courier.membershipId} style={[styles.teamRankRow,courier.membershipId===myId&&styles.teamRankRowMe]}><View style={styles.teamRankPosition}>{index < 3 ? <Text style={styles.teamRankPositionText}>{index+1}</Text> : null}</View><RankAvatar uri={courier.photoUri} name={courier.name}/><View style={styles.teamRankInfo}><Text style={styles.teamRankName}>{courier.name}{courier.membershipId===myId?' · você':''}</Text><Text style={styles.teamRankDeliveries}>{period==='week'?courier.weekCompleted:courier.monthCompleted} entregas</Text></View></View>)}<Text style={styles.rankEncouragement}>{encouragement}</Text></View>;
}

function RankAvatar({uri,name}:{uri?:string|null;name:string}) {
  const [failed,setFailed] = useState(false);
  const initial = name.trim().slice(0,1).toUpperCase() || 'E';
  return <View style={styles.teamRankAvatar}>{uri && !failed
    ? <Image source={{uri}} style={styles.teamRankAvatarImage} onError={() => setFailed(true)}/>
    : <Text style={styles.teamRankAvatarInitial}>{initial}</Text>}</View>;
}

function CalendarDialog({
  visible, value, month, onMonth, onSelect, onClose,
}: {
  visible: boolean; value: string; month: string; onMonth: (value: string) => void;
  onSelect: (value: string) => void; onClose: () => void;
}) {
  const days = monthDays(month);
  function moveMonth(direction: number) {
    const [year, monthNumber] = month.split('-').map(Number);
    const date = new Date(Date.UTC(year!, monthNumber! - 1 + direction, 1));
    onMonth(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.modalBackdrop}>
      <View style={styles.calendarCard}>
        <Text style={styles.calendarEyebrow}>FILTRAR ENTREGAS</Text>
        <View style={styles.calendarHeader}>
          <Pressable style={styles.calendarArrow} onPress={() => moveMonth(-1)} accessibilityLabel="Mês anterior"><Text style={styles.calendarArrowText}>‹</Text></Pressable>
          <Text style={styles.calendarMonth}>{monthLabel(month)}</Text>
          <Pressable style={styles.calendarArrow} onPress={() => moveMonth(1)} accessibilityLabel="Próximo mês"><Text style={styles.calendarArrowText}>›</Text></Pressable>
        </View>
        <View style={styles.calendarGrid}>
          {['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((label, index) => <Text key={`${label}-${index}`} style={styles.weekday}>{label}</Text>)}
          {days.map((day, index) => day
            ? <Pressable key={day} onPress={() => onSelect(day)} style={[styles.calendarDay, day === value && styles.calendarDaySelected, day === dayKey(new Date()) && day !== value && styles.calendarDayToday]} accessibilityRole="button" accessibilityState={{ selected: day === value }}>
              <Text style={[styles.calendarDayText, day === value && styles.calendarDayTextSelected]}>{Number(day.slice(-2))}</Text>
            </Pressable>
            : <View key={`blank-${index}`} style={styles.calendarDay}/>
          )}
        </View>
        <View style={styles.calendarActions}>
          <Pressable onPress={() => onSelect(dayKey(new Date()))}><Text style={styles.calendarToday}>Ir para hoje</Text></Pressable>
          <Pressable style={styles.calendarClose} onPress={onClose}><Text style={styles.calendarCloseText}>Fechar</Text></Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}

export default function Home() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [serverUrl, setServerUrl] = useState(defaultBaseUrl);
  const [items, setItems] = useState<Delivery[]>([]);
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<CourierProfile | null>(null);
  const [productivity, setProductivity] = useState<Productivity | null>(null);
  const [period, setPeriod] = useState<Period>('week');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [coverUri, setCoverUri] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MainTab>('ritmo');
  const [deliveryTab, setDeliveryTab] = useState<DeliveryTab>('open');
  const [availableDeliveries,setAvailableDeliveries]=useState<Delivery[]>([]);
  const [routeSelection,setRouteSelection]=useState<string[]>([]);
  const [routeSelectionMode,setRouteSelectionMode]=useState(false);
  const [expandedDeliveryGroups,setExpandedDeliveryGroups]=useState<string[]>([]);
  const [deliveryDate, setDeliveryDate] = useState(dayKey(new Date()));
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(dayKey(new Date()).slice(0, 7));
  const [notificationsGranted, setNotificationsGranted] = useState(false);
  const [pushReady,setPushReady]=useState<boolean|null>(null);
  const [pushReason,setPushReason]=useState('');
  const [developerMode, setDeveloperMode] = useState(false);
  const versionTaps = useRef(0);
  const versionTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    configuredBaseUrl().then(setServerUrl).catch(() => {});
    SecureStore.getItemAsync('developerMode').then(value => setDeveloperMode(value === 'true')).catch(() => {});
    SecureStore.getItemAsync('session').then(token => {
      setAuthed(!!token);
      setItems(deliveries());
      setReady(true);
    });
  }, []);

  useFocusEffect(useCallback(() => {
    if (authed) setItems(deliveries());
  }, [authed]));

  useEffect(()=>{
    setRouteSelection([]);
    setRouteSelectionMode(false);
    setExpandedDeliveryGroups([]);
  },[deliveryDate,deliveryTab]);

  async function cacheProfileImage(kind: 'photo' | 'cover'): Promise<string | null> {
    const token = await SecureStore.getItemAsync('session');
    if (!token) return null;
    const base = await configuredBaseUrl();
    const filename = `courier-${kind}-${Date.now()}.jpg`;
    const file = await FileSystem.downloadAsync(`${base}/v1/mobile/profile/${kind}?version=${Date.now()}`,
      `${FileSystem.cacheDirectory}${filename}`, { headers: { Authorization: `Bearer ${token}` } });
    return file.uri;
  }

  async function attachLeaderboardPhotos(value:Productivity):Promise<Productivity>{
    const token=await SecureStore.getItemAsync('session');
    if(!token||!value.leaderboard?.length)return value;
    const base=await configuredBaseUrl();
    const leaderboard=await Promise.all(value.leaderboard.map(async courier=>{
      if(!courier.hasPhoto)return {...courier,photoUri:null};
      const path=`${FileSystem.cacheDirectory}leaderboard-${courier.membershipId}.jpg`;
      const cached=await FileSystem.getInfoAsync(path);
      if(cached.exists)return {...courier,photoUri:path};
      try{
        const downloaded=await FileSystem.downloadAsync(`${base}/v1/mobile/leaderboard/${courier.membershipId}/photo`,path,{headers:{Authorization:`Bearer ${token}`}});
        return {...courier,photoUri:downloaded.uri};
      }catch{return {...courier,photoUri:null}}
    }));
    return {...value,leaderboard};
  }

  async function loadProfile() {
    const next = await request<CourierProfile>('/mobile/profile');
    setProfile(next);
    const [avatar, cover] = await Promise.all([
      next.has_photo ? cacheProfileImage('photo') : Promise.resolve(null),
      next.has_cover ? cacheProfileImage('cover') : Promise.resolve(null),
    ]);
    setAvatarUri(avatar);
    setCoverUri(cover);
  }

  useEffect(() => {
    if (!authed) return;
    registerDevice().then(result=>{setPushReady(result.pushReady);setNotificationsGranted(result.permissionGranted);setPushReason(result.reason)}).catch(()=>{setPushReady(false);setPushReason('Não foi possível configurar os avisos neste aparelho.')});
    loadProfile().catch(() => {});
    Notifications.getPermissionsAsync().then(result => setNotificationsGranted(result.granted)).catch(() => {});
    return onNotification(() => { refresh(); });
  }, [authed]);

  async function refresh() {
    setBusy(true);
    try {
      await resumeRouteTracking().catch(()=>{});
      await flushOperations();
      setItems(await syncDeliveries());
      const [nextProfile, nextProductivity] = await Promise.all([
        request<CourierProfile>('/mobile/profile'),
        request<Productivity>(`/mobile/productivity?period=${period}`).then(attachLeaderboardPhotos),
      ]);
      setProfile(nextProfile);
      const [avatar, cover] = await Promise.all([
        nextProfile.has_photo ? cacheProfileImage('photo') : Promise.resolve(null),
        nextProfile.has_cover ? cacheProfileImage('cover') : Promise.resolve(null),
      ]);
      setAvatarUri(avatar);
      setCoverUri(cover);
      await SecureStore.setItemAsync('celebrationEnabled', String(nextProductivity.celebrationEnabled !== false));
      await SecureStore.setItemAsync('problemReasons', JSON.stringify(nextProductivity.problemReasons ?? []));
      setProductivity(nextProductivity);
    } catch (error) {
      if ((error as { status?: number }).status === 401) {
        await SecureStore.deleteItemAsync('session');
        setItems([]);
        setAuthed(false);
        Alert.alert('Sessão expirada', 'Entre novamente para enviar suas operações pendentes.');
      } else {
        Alert.alert('Sincronização', 'Não foi possível atualizar agora. Os dados locais continuam disponíveis.');
      }
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (!authed) return;
    let mounted=true;
      const updateProductivity=()=>{request<Productivity>(`/mobile/productivity?period=${period}`).then(attachLeaderboardPhotos).then(value=>{if(mounted){void SecureStore.setItemAsync('celebrationEnabled',String(value.celebrationEnabled !== false));void SecureStore.setItemAsync('problemReasons',JSON.stringify(value.problemReasons ?? []));setProductivity(value)}}).catch(()=>{});};
    updateProductivity();
    const timer=setInterval(updateProductivity,60_000);
    const appState=AppState.addEventListener('change',state=>{if(state==='active')updateProductivity()});
    return()=>{mounted=false;clearInterval(timer);appState.remove()};
  }, [period, authed]);

  useEffect(()=>{
    if(!authed)return;
    let active=true,initialized=false,polling=false;
    const known=new Map(deliveries().map(item=>[item.id,item.status]));
    const poll=async()=>{
      if(polling)return;
      polling=true;
      try{
        const latest=await syncDeliveries();
        if(!active)return;
        if(initialized){
          for(const delivery of latest){
            if(['assigned','in_progress'].includes(delivery.status)&&!['assigned','in_progress'].includes(known.get(delivery.id)??'')){
              await Notifications.scheduleNotificationAsync({content:{title:'Nova entrega',body:`${delivery.customer_name} · ${delivery.merchandise_description}`,data:{deliveryId:delivery.id}},trigger:null});
            }
          }
        }
        initialized=true;
        latest.forEach(item=>known.set(item.id,item.status));
        setItems(latest);
      }catch{/* FCM remains the delivery path while the app is closed. */}
      finally{polling=false;}
    };
    void poll();
    const timer=setInterval(()=>{if(AppState.currentState==='active')void poll()},30_000);
    const appState=AppState.addEventListener('change',state=>{if(state==='active')void poll()});
    return()=>{active=false;clearInterval(timer);appState.remove()};
  },[authed]);

  const progress = productivity ?? localProductivity(items, period);
  useEffect(()=>{if(authed&&activeTab==='deliveries'&&deliveryTab==='available')request<{items:Delivery[]}>('/mobile/available').then(result=>setAvailableDeliveries(result.items)).catch(()=>Alert.alert('Entregas disponíveis','Não foi possível carregar as entregas disponíveis.'));},[authed,activeTab,deliveryTab]);
  const visibleDeliveries = useMemo(() => items.filter(item => {
    if (deliveryTab === 'open') {
      if (item.status === 'completed' || item.status === 'cancelled') return false;
      if (item.scheduled_for) return dayKey(item.scheduled_for) <= deliveryDate;
      return !!item.created_at && dayKey(item.created_at) <= deliveryDate;
    }
    if (item.status !== 'completed' && item.status !== 'cancelled') return false;
    const terminalAt = item.completed_at ?? item.cancelled_at ?? item.updated_at;
    return !!terminalAt && dayKey(terminalAt) === deliveryDate;
  }), [items, deliveryTab, deliveryDate]);
  const deliveryRows=useMemo<DeliveryRow[]>(()=>{
    const source=deliveryTab==='available'?availableDeliveries:visibleDeliveries;
    if(deliveryTab==='available')return source;
    const groups=new Map<string,Delivery[]>();
    for(const delivery of source){
      const address=delivery.destination_snapshot??{};
      const key=[address.street,address.number,address.neighborhood,address.city,address.state,address.postal_code].map(value=>String(value??'').trim().toLocaleLowerCase('pt-BR')).join('|');
      const current=groups.get(key)??[]; current.push(delivery); groups.set(key,current);
    }
    return [...groups.values()].map(group=>group.length>1?{...group[0]!,groupedDeliveries:group}:group[0]!);
  },[availableDeliveries,deliveryTab,visibleDeliveries]);
  function toggleDeliveryGroup(id:string){setExpandedDeliveryGroups(groups=>groups.includes(id)?groups.filter(value=>value!==id):[...groups,id]);}
  function callCustomer(item:Delivery){if(!item.customer_phone){Alert.alert('Telefone indisponível','Este cliente não possui telefone cadastrado.');return;}Linking.openURL(`tel:${item.customer_phone}`).catch(()=>Alert.alert('Telefone','Não foi possível abrir o telefone neste aparelho.'));}
  function openDeliveryMap(item:Delivery){const address=item.destination_snapshot??{};const query=[address.street,address.number,address.neighborhood,address.city,address.state,address.postal_code].filter(Boolean).join(', ');const coordinates=address.reference_latitude!=null&&address.reference_longitude!=null?`${address.reference_latitude},${address.reference_longitude}`:query;Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coordinates)}`).catch(()=>Alert.alert('Mapa','Não foi possível abrir o aplicativo de mapas.'));}
  async function claimDelivery(id:string){try{await request(`/deliveries/${id}/claim`,{method:'POST',body:'{}'});setDeliveryTab('open');await refresh();Alert.alert('Entrega aceita','A entrega agora está na sua lista.')}catch(error){Alert.alert('Entrega indisponível',userFacingError(error,'Não foi possível aceitar esta entrega.'));request<{items:Delivery[]}>('/mobile/available').then(result=>setAvailableDeliveries(result.items)).catch(()=>{});}}
  async function createAndStartRoute(){try{const result=await request<{id:string}>('/mobile/routes',{method:'POST',body:JSON.stringify({deliveryIds:routeSelection})});await startRouteTracking(result.id);setRouteSelection([]);setRouteSelectionMode(false);Alert.alert('Rota iniciada','O GPS será compartilhado enquanto esta rota estiver ativa.')}catch(error){Alert.alert('Não foi possível iniciar a rota',userFacingError(error,'Tente novamente em instantes.'))}}

  async function chooseProfileImage(kind: 'photo' | 'cover') {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permissão necessária', 'Permita acesso às fotos para escolher uma imagem.');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], allowsEditing: true,
      aspect: kind === 'photo' ? [1, 1] : [12, 5], quality: 0.82,
    });
    if (picked.canceled || !picked.assets[0]) return;
    const data = new FormData();
    data.append('photo', {
      uri: picked.assets[0].uri, name: `${kind}.jpg`, type: picked.assets[0].mimeType ?? 'image/jpeg',
    } as unknown as Blob);
    try {
      const next = await request<CourierProfile>(`/mobile/profile/${kind}`, { method: 'PUT', body: data });
      setProfile(next);
      const uri = await cacheProfileImage(kind);
      if (kind === 'photo') setAvatarUri(uri); else setCoverUri(uri);
    } catch (error) { Alert.alert(kind === 'photo' ? 'Foto de perfil' : 'Capa do perfil', userFacingError(error,'Não foi possível atualizar a imagem.')); }
  }

  async function saveServerUrl() {
    try {
      await setBaseUrl(serverUrl);
      const configured = await configuredBaseUrl();
      setServerUrl(configured);
      await refresh();
      Alert.alert('Configurações salvas', 'A URL da API foi atualizada.');
    } catch (error) { Alert.alert('Configuração', userFacingError(error,'Não foi possível salvar esta configuração.')); }
  }

  async function leave() {
    await unregisterDevice();
    await signOut();
    reset();
    setAuthed(false);
    setItems([]);
    setProfile(null);
    setProductivity(null);
    setAvatarUri(null);
    setCoverUri(null);
    setActiveTab('ritmo');
  }

  async function enter() {
    setBusy(true);
    try {
      await setBaseUrl(serverUrl);
      const account = await signIn(email, password);
      prepareAccount(accountKey(account.tenant.id, account.user.id));
      setItems(deliveries());
      setAuthed(true);
      await registerDevice().catch(() => {});
      await refresh();
    } catch (error) { Alert.alert('Acesso', userFacingError(error,'Não foi possível entrar. Confira seus dados e tente novamente.')); }
    finally { setBusy(false); }
  }

  function requestLeave() {
    if (operations().length) {
      Alert.alert('Operações pendentes', 'Sair agora descarta operações que ainda não foram enviadas.', [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Sair e descartar', style: 'destructive', onPress: () => { leave().catch(() => Alert.alert('Sair', 'Não foi possível encerrar a sessão agora.')); } },
      ]);
    } else leave().catch(() => Alert.alert('Sair', 'Não foi possível encerrar a sessão agora.'));
  }

  function tapVersion() {
    versionTaps.current += 1;
    if (versionTapTimer.current) clearTimeout(versionTapTimer.current);
    versionTapTimer.current = setTimeout(() => { versionTaps.current = 0; }, 1800);
    if (versionTaps.current >= 7) {
      versionTaps.current = 0;
      const next = !developerMode;
      setDeveloperMode(next);
      SecureStore.setItemAsync('developerMode', String(next)).catch(() => {});
      Alert.alert('Modo desenvolvedor', next ? 'Ativado neste aparelho.' : 'Desativado neste aparelho.');
    }
  }

  if (!ready) return <View style={styles.page}><Text style={styles.meta}>Carregando…</Text></View>;

  if (!authed) return (
    <SafeAreaView style={styles.safePage} edges={['top', 'bottom']}>
      <View style={styles.login}>
        <Logo />
        <Text style={styles.title}>Área do entregador</Text>
        <TextInput style={styles.input} placeholder="E-mail" autoCapitalize="none" keyboardType="email-address" value={email} onChangeText={setEmail}/>
        <TextInput style={styles.input} placeholder="Senha" secureTextEntry value={password} onChangeText={setPassword}/>
        <Pressable onPress={tapVersion} accessibilityRole="button"><Text style={styles.loginVersion}>Entrega Já {Constants.expoConfig?.version ?? 'Android'}</Text></Pressable>
        {developerMode && <><Text style={styles.fieldLabel}>URL da API (modo desenvolvedor)</Text><TextInput style={styles.input} placeholder="URL da API" value={serverUrl} autoCapitalize="none" keyboardType="url" onChangeText={setServerUrl}/></>}
        <Pressable style={styles.primaryButton} onPress={enter} disabled={busy}><Text style={styles.primaryButtonText}>{busy ? 'Entrando…' : 'Entrar'}</Text></Pressable>
      </View>
    </SafeAreaView>
  );

  const headerTitle = tabTitles[activeTab];
  const isOverdue = (item: Delivery) => !!item.scheduled_for && dayKey(item.scheduled_for) < deliveryDate;
  const localCompleted = progress.lifetime ?? items.filter(item => item.status === 'completed').length;
  const badges = progress.badges?.length ? progress.badges : [
    { id: 'default-first', title: 'Primeira entrega', hint: 'Conclua sua primeira entrega', target: 1 },
    { id: 'default-start', title: 'Bom começo', hint: 'Alcance 5 entregas concluídas', target: 5 },
    { id: 'default-moving', title: 'Em movimento', hint: 'Alcance 25 entregas concluídas', target: 25 },
    { id: 'default-gold', title: 'Rota de ouro', hint: 'Alcance 50 entregas concluídas', target: 50 },
  ];

  return (
    <SafeAreaView style={styles.safePage} edges={['top', 'bottom']}>
      <View style={styles.appShell}>
        <View style={styles.topBar}>
          <View><Text style={styles.brandEyebrow}>ENTREGA JÁ</Text><Text style={styles.screenTitle}>{headerTitle}</Text></View>
          <View style={{width: 48, height: 48}} />
        </View>

        <View style={styles.screenBody}>
          {activeTab === 'ritmo' && <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <View style={styles.introCard}>
              <View style={styles.introMark}><Icon name="check" color={brand.petroleumDark} size={24}/></View>
              <View style={styles.introText}><Text style={styles.introTitle}>Seu trabalho faz a diferença</Text><Text style={styles.introSubtitle}>Acompanhe cada conquista da sua rota.</Text></View>
            </View>
            <View style={styles.dailyGoalCard}><ProgressRing value={Math.min(100, progress.summary.day / (progress.dailyGoal ?? 10) * 100)} size={78} /><View style={styles.dailyGoalCopy}><Text style={styles.sectionTitle}>Meta de hoje</Text><Text style={styles.dailyGoalValue}>{progress.summary.day} <Text style={styles.dailyGoalMuted}>/ {progress.dailyGoal ?? 10} entregas</Text></Text><Text style={styles.meta}>{progress.streakDays ? `${progress.streakDays} dias seguidos` : 'Comece sua sequência hoje'}</Text><Text style={styles.streakRule}>A sequência conta dias consecutivos com ao menos uma entrega concluída.</Text></View></View>
            {progress.weeklySummary && <View style={styles.weeklySummaryCard}><Text style={styles.sectionTitle}>Resumo da semana</Text><Text style={styles.meta}>Na semana passada você concluiu {progress.weeklySummary.previous} entregas.</Text><Text style={styles.weeklySummaryValue}>{progress.weeklySummary.current >= progress.weeklySummary.previous ? `Você foi ${progress.weeklySummary.previous ? Math.round((progress.weeklySummary.current / progress.weeklySummary.previous - 1) * 100) : 100}% mais produtivo.` : `Você concluiu ${Math.round((1 - progress.weeklySummary.current / Math.max(1, progress.weeklySummary.previous)) * 100)}% menos entregas.`}</Text></View>}
            <ProgressPanel progress={progress} period={period} setPeriod={setPeriod}/>
            <View style={styles.missionCard}>
              <View style={styles.missionHeading}><View><Text style={styles.sectionTitle}>Missão da semana</Text><Text style={styles.meta}>Seu próximo marco está mais perto</Text></View><Icon name="check" color={brand.accent} size={26}/></View>
              <View style={styles.missionTargetRow}><Text style={styles.missionTarget}>{progress.summary.week}</Text><Text style={styles.missionTargetMuted}> / {progress.challenge?.target ?? 10} entregas</Text><Text style={styles.missionPercent}>{Math.min(100, Math.round(progress.summary.week / (progress.challenge?.target ?? 10) * 100))}%</Text></View>
              <View style={styles.missionTrack}><View style={[styles.missionFill, { width: `${Math.min(100, progress.summary.week / (progress.challenge?.target ?? 10) * 100)}%` }]}/></View>
              <Text style={styles.meta}>{progress.summary.week >= (progress.challenge?.target ?? 10) ? 'Missão concluída. Você está em grande ritmo!' : `Faltam ${Math.max(0, (progress.challenge?.target ?? 10) - progress.summary.week)} entregas para completar a missão.`}</Text>
            </View>
            <View style={styles.statTiles}>
              <StatTile label="Hoje" value={progress.summary.day}/>
              <StatTile label="Esta semana" value={progress.summary.week}/>
              <StatTile label="Este mês" value={progress.summary.month}/>
            </View>
            {progress.metrics && <View style={styles.metricsCard}><Text style={styles.sectionTitle}>Como você está indo</Text><View style={styles.metricsGrid}><View><Text style={styles.meta}>Tempo médio</Text><Text style={styles.metricValue}>{progress.metrics.averageMinutes == null ? '—' : `${Math.round(progress.metrics.averageMinutes)} min`}</Text></View><View><Text style={styles.meta}>No prazo</Text><Text style={styles.metricValue}>{Math.round(progress.metrics.onTimePercent)}%</Text></View><View><Text style={styles.meta}>Distância</Text><Text style={styles.metricValue}>{progress.metrics.distanceKm.toFixed(1)} km</Text></View></View><Text style={styles.meta}>Ganhos estimados: {progress.metrics.estimatedEarningsCents == null ? 'indisponíveis' : formatMoney(progress.metrics.estimatedEarningsCents)}</Text>{progress.weekComparison && <Text style={styles.meta}>{progress.weekComparison.current >= progress.weekComparison.previous ? `Você está ${progress.weekComparison.previous ? Math.round((progress.weekComparison.current / progress.weekComparison.previous - 1) * 100) : 100}% acima da semana anterior.` : `Você está ${Math.round((1 - progress.weekComparison.current / Math.max(1, progress.weekComparison.previous)) * 100)}% abaixo da semana anterior.`}</Text>}</View>}
            {progress.leaderboard&&<UnifiedSeasonalRank couriers={progress.leaderboard} myId={progress.currentMembershipId}/>} 
            <Pressable style={styles.secondarySync} onPress={refresh} disabled={busy}><Text style={styles.secondarySyncText}>{busy ? 'Sincronizando…' : 'Atualizar meu ritmo'}</Text></Pressable>
          </ScrollView>}

          {activeTab === 'deliveries' && <FlatList
            data={deliveryRows}
            refreshControl={<RefreshControl refreshing={busy} onRefresh={refresh} tintColor={brand.petroleum} colors={[brand.petroleum]} />}
            keyExtractor={item => item.id}
            contentContainerStyle={deliveryRows.length ? styles.list : styles.listEmpty}
            ListHeaderComponent={<View style={styles.deliveryHeader}>
              {deliveryTab==='open'&&<><Pressable style={[styles.secondarySync,{marginTop:10},routeSelectionMode&&styles.routeSelectionToggleActive]} onPress={()=>{setRouteSelectionMode(mode=>{if(mode)setRouteSelection([]);return !mode;})}} accessibilityRole="button" accessibilityState={{selected:routeSelectionMode}}><Text style={[styles.secondarySyncText,routeSelectionMode&&styles.routeSelectionToggleTextActive]}>{routeSelectionMode?'Cancelar montagem da rota':'Montar rota'}</Text></Pressable>{routeSelectionMode&&<View style={styles.routeSelectionHint}><Text style={styles.routeSelectionHintText}>{routeSelection.length?`Toque nas entregas na ordem da rota · ${routeSelection.length} selecionada(s)`:'Toque nas entregas na ordem em que devem ser feitas.'}</Text></View>}{routeSelection.length>0&&<Pressable style={styles.syncButton} onPress={createAndStartRoute}><Text style={styles.primaryButtonText}>Iniciar rota · {routeSelection.length} parada(s)</Text></Pressable>}</>}
              {operations().length > 0 && <Text style={styles.pendingText}>{operations().length} operação(ões) aguardando envio</Text>}
              {failedOperations().length > 0 && <Pressable style={styles.errorCard} onPress={() => {
                const failed = failedOperations();
                const summary = failed.slice(0, 3).map(operation => `${operation.kind === 'completion' ? 'Conclusão' : operation.kind === 'check_in' ? 'Check-in' : 'Problema'}: ${operation.error ?? 'Não enviada'}`).join('\n');
                Alert.alert('Operações para revisar', `${summary}${failed.length > 3 ? '\n…' : ''}`, [
                  { text: 'Fechar' },
                  { text: 'Tentar novamente', onPress: async () => { for (const operation of failed) retryFailed(operation.id); await flushOperations().catch(() => {}); setItems(deliveries()); } },
                  { text: 'Descartar falhas', style: 'destructive', onPress: () => { discardFailedOperations().then(() => setItems(deliveries())); } },
                ]);
              }}><Text style={styles.errorText}>{failedOperations().length} operação(ões) exigem revisão. Toque para ver.</Text></Pressable>}
              <View style={styles.deliveryTabs}>
                {(['open', 'finished','available'] as const).map(tab => <Pressable key={tab} onPress={() => setDeliveryTab(tab)} style={[styles.deliveryTab, deliveryTab === tab && styles.deliveryTabActive]} accessibilityRole="tab" accessibilityState={{ selected: deliveryTab === tab }}>
                  <Text style={[styles.deliveryTabText, deliveryTab === tab && styles.deliveryTabTextActive]}>{tab === 'open' ? 'Em aberto' : tab==='finished'?'Finalizadas':'Disponíveis'}</Text>
                  <Text style={[styles.deliveryTabCount, deliveryTab === tab && styles.deliveryTabTextActive]}>{tab==='available'?availableDeliveries.length:visibleDeliveries.length}</Text>
                </Pressable>)}
              </View>
              {deliveryTab!=='available'&&<><Pressable style={styles.datePickerButton} onPress={() => { setCalendarMonth(deliveryDate.slice(0, 7)); setCalendarOpen(true); }} accessibilityRole="button" accessibilityLabel={`Filtrar entregas por dia: ${dateLabel(deliveryDate)}`}>
                <View style={styles.calendarGlyph}><Text style={styles.calendarGlyphText}>▦</Text></View>
                <View style={styles.datePickerInfo}><Text style={styles.datePickerCaption}>MOSTRANDO ENTREGAS DE</Text><Text style={styles.datePickerValue}>{dateLabel(deliveryDate)}</Text></View>
                <Text style={styles.datePickerChange}>Alterar</Text>
              </Pressable>
              <View style={styles.dateStepper}>
                <Pressable style={styles.dayStepButton} onPress={() => setDeliveryDate(day => shiftDay(day, -1))} accessibilityLabel="Dia anterior"><Text style={styles.dayStepText}>‹ Dia anterior</Text></Pressable>
                <Pressable style={styles.todayButton} onPress={() => setDeliveryDate(dayKey(new Date()))}><Text style={styles.todayText}>Hoje</Text></Pressable>
                <Pressable style={styles.dayStepButton} onPress={() => setDeliveryDate(day => shiftDay(day, 1))} accessibilityLabel="Próximo dia"><Text style={styles.dayStepText}>Próximo dia ›</Text></Pressable>
              </View>
              <Text style={styles.dateHint}>{deliveryTab === 'open' ? 'Inclui entregas atrasadas de dias anteriores.' : 'Concluídas ou canceladas na data selecionada.'}</Text>
              </>}
              <Text style={styles.deliveryCount}>{deliveryTab==='available'?deliveryRows.length:visibleDeliveries.length} {(deliveryTab==='available'?deliveryRows.length:visibleDeliveries.length) === 1 ? 'entrega' : 'entregas'}{deliveryTab!=='available'&&deliveryRows.length<visibleDeliveries.length?` · ${deliveryRows.length} endereços`:''}</Text>
            </View>}
            ListEmptyComponent={<EmptyState icon={deliveryTab === 'open' ? 'check' : 'clock'} title={deliveryTab === 'available'?'Nenhuma entrega disponível':deliveryTab === 'open' ? 'Tudo em dia por aqui' : 'Nenhuma entrega finalizada neste dia'} message="Tente sincronizar novamente mais tarde."/>}
            renderItem={({ item }) => {const grouped=item.groupedDeliveries??[item];const expanded=expandedDeliveryGroups.includes(item.id);const routeOrder=routeSelection.indexOf(item.id);return <Pressable style={[styles.deliveryCard,routeOrder>=0&&styles.routeSelectedCard]} onPress={() => deliveryTab==='available'?undefined:routeSelectionMode?setRouteSelection(ids=>toggleRouteSelection(ids,item.id)):router.push({ pathname: '/delivery/[id]', params: { id: item.id } })} onLongPress={()=>{if(deliveryTab==='open'){setRouteSelectionMode(true);setRouteSelection(ids=>ids.includes(item.id)?ids:toggleRouteSelection(ids,item.id));}}} accessibilityRole="button" accessibilityState={{selected:routeOrder>=0}} accessibilityHint={routeSelectionMode?'Toque para incluir ou remover esta entrega da rota. A ordem dos toques define as paradas.':'Toque para abrir. Mantenha pressionado para começar a montar uma rota.'} accessibilityLabel={`${item.customer_name}, ${item.merchandise_description}, ${deliveryTab==='available'?'Disponível':deliveryStatusLabel(item.status)}${routeOrder>=0?`, parada ${routeOrder+1} selecionada`:''}`}>
              <View style={styles.cardHeading}><View style={styles.cardTitleGroup}>{routeOrder>=0&&<View style={styles.routeOrderBadge}><Text style={styles.routeOrderBadgeText}>{routeOrder+1}</Text></View>}<Text style={styles.name}>{item.customer_name}</Text></View><View style={styles.cardStatusGroup}><StatusChip status={deliveryTab==='available'?'assigned':isOverdue(item)?'overdue':item.status as 'assigned'|'in_progress'|'completed'|'problem'|'pending'} label={deliveryTab==='available'?'Disponível':isOverdue(item)?'Atrasada':deliveryStatusLabel(item.status)}/></View></View>
              {grouped.length>1&&<Pressable onPress={()=>toggleDeliveryGroup(item.id)} accessibilityRole="button" accessibilityLabel={expanded?"Ocultar entregas deste endereço":"Expandir entregas deste endereço"}><Text style={styles.groupSummary}>{expanded?"Ocultar detalhes":`${grouped.length} entregas neste endereço`}</Text></Pressable>}{expanded&&<View style={styles.groupedDeliveryList}>{grouped.slice(1).map(delivery=><Text key={delivery.id} style={styles.groupedDeliveryText}>{delivery.merchandise_description}</Text>)}</View>}{item.items?.length?<View style={{flexDirection:'row',flexWrap:'wrap',gap:7}}>{item.items.map(volume=><View key={volume.id} style={{flexDirection:'row',alignItems:'center',gap:5,backgroundColor:'#EEF4F5',borderRadius:10,paddingHorizontal:10,paddingVertical:7}}><VolumeIcon/><Text style={styles.meta}>{volume.quantity}× {volume.name}</Text></View>)}</View>:<Text style={styles.meta}>{item.merchandise_description}</Text>}
              {shortAddress(item).map((line, index) => <Text style={styles.addressLine} key={`${item.id}-${index}`}>{line}</Text>)}
              {item.scheduled_for && <Text style={styles.schedule}>Previsão: {new Date(item.scheduled_for).toLocaleString('pt-BR', { timeZone: TIME_ZONE })}</Text>}
              <View style={styles.quickActions}>{item.status==='assigned'&&<Pressable style={styles.quickAction} onPress={()=>router.push({ pathname: '/delivery/[id]', params: { id: item.id } })}><Text style={styles.quickActionText}>Iniciar</Text></Pressable>}{item.customer_phone&&<Pressable style={styles.quickAction} onPress={()=>callCustomer(item)}><Text style={styles.quickActionText}>Ligar</Text></Pressable>}<Pressable style={styles.quickAction} onPress={()=>openDeliveryMap(item)}><Text style={styles.quickActionText}>Abrir no mapa</Text></Pressable></View>
              {item.estimated_earnings_cents != null && <Text style={styles.earnings}>A receber: {formatMoney(item.estimated_earnings_cents)}</Text>}
              {deliveryTab==='available'&&<Pressable style={styles.syncButton} onPress={()=>claimDelivery(item.id)}><Text style={styles.primaryButtonText}>Pegar entrega</Text></Pressable>}
            </Pressable>}}
          />}

          {activeTab === 'profile' && <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <View style={styles.profileHero}>
              <View style={styles.coverFrame}>
                {coverUri ? <Image source={{ uri: coverUri }} style={styles.coverImage}/> : <View style={styles.coverPlaceholder}><Text style={styles.coverDecoration}>ENTREGA JÁ</Text><Text style={styles.coverMessage}>Cada rota conta.</Text></View>}
                <Pressable style={styles.coverEditButton} onPress={() => chooseProfileImage('cover')} accessibilityRole="button" accessibilityLabel="Adicionar ou alterar capa"><Text style={styles.coverEditText}>Editar capa</Text></Pressable>
              </View>
              <View style={styles.profileIdentity}>
                <Pressable style={styles.avatarButton} onPress={() => chooseProfileImage('photo')} accessibilityRole="button" accessibilityLabel="Adicionar ou alterar foto do perfil">
                  {avatarUri ? <Image source={{ uri: avatarUri }} style={styles.avatar}/> : <View style={styles.avatarPlaceholder}><Text style={styles.avatarInitial}>{profile?.full_name?.slice(0, 1).toUpperCase() ?? 'E'}</Text></View>}
                  <View style={styles.cameraBadge}><Text style={styles.cameraText}>＋</Text></View>
                </Pressable>
                <View style={styles.profileIdentityText}><Text style={styles.profileName}>{profile?.full_name ?? 'Seu perfil'}</Text><Text style={styles.profileCaption}>Entregador</Text></View>
              </View>
            </View>
            <View style={styles.missionSectionHeading}><View><Text style={styles.sectionTitle}>Temporada atual</Text><Text style={styles.meta}>Disputas reiniciadas a cada semana e mês</Text></View></View>
            <View style={styles.seasonalAwardGrid}><SeasonalAwardCard title="Entregador da semana" gem="ruby" period="week" award={progress.seasonalAwards?.week}/><SeasonalAwardCard title="Entregador do mês" gem="emerald" period="month" award={progress.seasonalAwards?.month}/></View>
            <View style={styles.missionSectionHeading}><View><Text style={styles.sectionTitle}>Minhas medalhas</Text><Text style={styles.meta}>Marcos conquistados nas suas entregas</Text></View><Text style={styles.medalCount}>{badges.filter(badge => localCompleted >= badge.target).length}/{badges.length}</Text></View>
            <View style={styles.badgeGrid}>{badges.map(badge => {
              const progressValue = badge.progress ?? localCompleted;
              const unlocked = badge.unlockedAt != null || progressValue >= badge.target;
              return <View key={badge.title} style={[styles.badgeCard, unlocked && styles.badgeCardUnlocked]}>
                <View style={[styles.badgeSeal, unlocked && styles.badgeSealUnlocked]}><Icon name={unlocked ? 'check' : 'clock'} color={brand.petroleum} size={20}/></View>
                <Text style={[styles.badgeTitle, !unlocked && styles.badgeLockedText]}>{badge.title}</Text>
                <Text style={styles.badgeHint}>{unlocked ? 'Conquistada' : `${progressValue}/${badge.target} · ${badge.hint}`}</Text>
                {!unlocked && <View style={styles.badgeTrack}><View style={[styles.badgeFill,{width:`${Math.min(100,progressValue/Math.max(1,badge.target)*100)}%`}]}/></View>}
              </View>;
            })}</View>
            <View style={styles.missionCard}><Text style={styles.sectionTitle}>{progress.challenge?.title ?? 'Desafio semanal'}</Text><Text style={styles.missionCopy}>{progress.challenge?.description || `Conclua ${progress.challenge?.target ?? 10} entregas nesta semana para completar a missão.`}</Text><View style={styles.missionTargetRow}><Text style={styles.missionTarget}>{progress.summary.week}</Text><Text style={styles.missionTargetMuted}> / {progress.challenge?.target ?? 10}</Text></View><View style={styles.missionTrack}><View style={[styles.missionFill, { width: `${Math.min(100, progress.summary.week / (progress.challenge?.target ?? 10) * 100)}%` }]}/></View></View>
          </ScrollView>}

          {activeTab === 'settings' && <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            <View style={styles.settingsIntro}><View style={styles.settingsIcon}><Icon name="settings" color={brand.petroleum} size={23}/></View><View><Text style={styles.sectionTitle}>Ajustes do aplicativo</Text><Text style={styles.meta}>Conexão e funcionamento da sua conta.</Text></View></View>
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Conexão com a API</Text><Text style={styles.meta}>Endereço do serviço usado para sincronizar sua rota.</Text>
              {developerMode ? <><Text style={styles.fieldLabel}>URL da API</Text><TextInput style={styles.input} value={serverUrl} autoCapitalize="none" keyboardType="url" onChangeText={setServerUrl}/><Pressable style={styles.primaryButton} onPress={saveServerUrl} disabled={busy}><Text style={styles.primaryButtonText}>{busy ? 'Salvando…' : 'Salvar e sincronizar'}</Text></Pressable></> : <Text style={styles.meta}>A conexão é gerenciada automaticamente.</Text>}
            </View>
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Notificações</Text><Text style={styles.meta}>{notificationsGranted ? 'Permissão ativa neste aparelho.' : 'Permissão desativada ou indisponível neste aparelho.'}</Text>
              <View style={styles.settingsRow}><Text style={styles.settingsRowLabel}>Avisos em primeiro plano</Text><Text style={[styles.settingsState, notificationsGranted && styles.settingsStateOn]}>{notificationsGranted ? 'Ativos' : 'Desativados'}</Text></View>
              <View style={styles.settingsRow}><Text style={styles.settingsRowLabel}>Avisos com app fechado</Text><Text style={[styles.settingsState,pushReady&&styles.settingsStateOn]}>{pushReady===null?'Verificando…':pushReady?'Ativos':'Inativos'}</Text></View>
              {pushReason&&!pushReady&&<Text style={styles.settingsFootnote}>{pushReason}</Text>}
              <Text style={styles.settingsFootnote}>Com o app aberto, novas entregas são verificadas automaticamente. Para alertas com o app fechado, o serviço Firebase precisa estar configurado.</Text>
            </View>
            <View style={styles.sectionCard}>
              <Text style={styles.sectionTitle}>Sincronização e dados</Text>
              <Pressable onPress={tapVersion} accessibilityRole="button"><Text style={styles.settingsRowLabel}>Versão do aplicativo</Text><Text style={styles.meta}>Entrega Já {Constants.expoConfig?.version ?? 'Android'}</Text></Pressable>
              {developerMode && <Text style={styles.settingsFootnote}>Modo desenvolvedor ativo.</Text>}
              <Text style={[styles.settingsRowLabel, styles.settingsGap]}>Operações pendentes</Text><Text style={styles.meta}>{operations().length} aguardando envio · {failedOperations().length} para revisar</Text>
              <Pressable style={styles.secondarySync} onPress={refresh} disabled={busy}><Text style={styles.secondarySyncText}>{busy ? 'Sincronizando…' : 'Sincronizar agora'}</Text></Pressable>
            </View>
            {failedOperations().length > 0 && <Pressable style={styles.errorCard} onPress={() => {
              const failed = failedOperations();
              const summary = failed.slice(0, 3).map(operation => `${operation.kind === 'completion' ? 'Conclusão' : operation.kind === 'check_in' ? 'Check-in' : 'Problema'}: ${operation.error ?? 'Não enviada'}`).join('\n');
              Alert.alert('Operações para revisar', `${summary}${failed.length > 3 ? '\n…' : ''}`, [
                { text: 'Fechar' },
                { text: 'Tentar novamente', onPress: async () => { for (const operation of failed) retryFailed(operation.id); await flushOperations().catch(() => {}); setItems(deliveries()); } },
                { text: 'Descartar falhas', style: 'destructive', onPress: () => { discardFailedOperations().then(() => setItems(deliveries())); } },
              ]);
            }}><Text style={styles.errorText}>Revisar operações com conflito</Text></Pressable>}
            <Pressable style={styles.logoutButton} onPress={requestLeave}><Text style={styles.logoutButtonText}>Sair da conta</Text></Pressable>
          </ScrollView>}
        </View>

        <View style={styles.dock} accessibilityRole="tablist" accessibilityLabel="Navegação principal">
          {(['ritmo', 'deliveries', 'profile', 'settings'] as const).map(tab => {
            const selected = activeTab === tab;
            return <Pressable key={tab} style={styles.dockItem} onPress={() => setActiveTab(tab)} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={tabTitles[tab]}>
              <View style={[styles.dockIconWrap, selected && styles.dockIconWrapSelected]}><AppIcon tab={tab} color={selected ? brand.petroleum : brand.muted}/></View>
              <Text style={[styles.dockLabel, selected && styles.dockLabelSelected]}>{tabTitles[tab]}</Text>
            </Pressable>;
          })}
        </View>
      </View>
      <CalendarDialog visible={calendarOpen} value={deliveryDate} month={calendarMonth} onMonth={setCalendarMonth}
        onSelect={date => { setDeliveryDate(date); setCalendarOpen(false); }} onClose={() => setCalendarOpen(false)}/>
    </SafeAreaView>
  );
}

function ProgressPanel({ progress, period, setPeriod }: { progress: Productivity; period: Period; setPeriod: (period: Period) => void }) {
  const max = Math.max(1, ...progress.items.map(item => item.count));
  return <View style={styles.progressCard}>
    <View style={styles.progressHeading}><View><Text style={styles.progressTitle}>Seu ritmo</Text><Text style={styles.progressSubtitle}>Entregas concluídas</Text></View><Text style={styles.progressHighlight}>{progress.summary[period]}</Text></View>
    <View style={styles.periodSwitch}>{(['day', 'week', 'month'] as const).map(option => <Pressable key={option} onPress={() => setPeriod(option)} style={[styles.periodButton, period === option && styles.periodButtonActive]} accessibilityRole="button" accessibilityState={{ selected: period === option }}>
      <Text style={[styles.periodText, period === option && styles.periodTextActive]}>{option === 'day' ? 'Dia' : option === 'week' ? 'Semana' : 'Mês'}</Text>
    </Pressable>)}</View>
    <View style={styles.chart}>{progress.items.map((point, index) => {
      const height = Math.max(5, Math.round(point.count / max * 76));
      const showLabel = period === 'week' || (period === 'day' ? index % 4 === 0 : index % 5 === 0 || index === progress.items.length - 1);
      return <View key={`${point.label}-${index}`} style={styles.chartColumn}>
        <Text style={styles.chartCount}>{point.count || ''}</Text><View style={styles.chartTrack}><View style={[styles.chartBar, { height, backgroundColor: point.count ? brand.petroleum : brand.border }]}/></View>
        {showLabel && <Text style={styles.chartLabel}>{point.label}</Text>}
      </View>;
    })}</View>
    <Text style={styles.motivation}>{progress.summary[period] === 0 ? 'Toda jornada começa com a primeira entrega.' : 'Cada entrega concluída é um passo a mais. Continue assim!'}</Text>
  </View>;
}

function StatTile({ label, value }: { label: string; value: number }) {
  return <View style={styles.statTile}><Text style={styles.statTileValue}>{value}</Text><Text style={styles.statTileLabel}>{label}</Text></View>;
}

export const styles = StyleSheet.create({
  safePage: { flex: 1, backgroundColor: brand.surface },
  appShell: { flex: 1, backgroundColor: brand.surface },
  page: { flex: 1, backgroundColor: brand.surface, padding: 20 },
  login: { flex: 1, justifyContent: 'center', backgroundColor: brand.surface, padding: 28, gap: 16 },
  topBar: { minHeight: 70, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brandEyebrow: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 10, letterSpacing: 1.8 },
  screenTitle: { fontFamily: 'Inter_600SemiBold', color: brand.text, fontSize: 25, marginTop: 2 },
  title: { fontFamily: 'Inter_600SemiBold', fontSize: 24, color: brand.text },
  screenBody: { flex: 1, minHeight: 0 },
  scrollContent: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 22, gap: 14 },
  input: { fontFamily: 'Inter_400Regular', backgroundColor: 'white', borderWidth: 1, borderColor: brand.border, borderRadius: 11, paddingHorizontal: 14, paddingVertical: 12, color: brand.text, fontSize: 14 },
  primaryButton: { backgroundColor: brand.petroleum, padding: 14, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginTop: 10, minHeight: 48 },
  primaryButtonText: { fontFamily: 'Inter_600SemiBold', color: 'white', fontSize: 14 },
  secondarySync: { backgroundColor: brand.petroleumLight, padding: 14, borderRadius: 11, alignItems: 'center', marginTop: 12, minHeight: 48, justifyContent: 'center' },
  routeSelectionToggleActive: { backgroundColor: brand.petroleum }, routeSelectionToggleTextActive: { color: 'white' },
  routeSelectionHint: { backgroundColor: '#FFFAEF', borderWidth: 1, borderColor: '#EAD8A8', borderRadius: 10, padding: 11, marginTop: 8 },
  routeSelectionHintText: { fontFamily: 'Inter_500Medium', color: brand.text, fontSize: 12, lineHeight: 17, textAlign: 'center' },
  secondarySyncText: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 14 },
  link: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, paddingVertical: 8, paddingHorizontal: 4 },
  loginVersion: { fontFamily: 'Inter_400Regular', color: brand.muted, fontSize: 11, textAlign: 'center', padding: 8, minHeight: 48, textAlignVertical: 'center' },
  meta: { fontFamily: 'Inter_400Regular', color: brand.muted, fontSize: 13, lineHeight: 19 },
  introCard: { minHeight: 90, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: brand.petroleumDark, borderRadius: 17, padding: 16, overflow: 'hidden' },
  introMark: { width: 40, height: 40, borderRadius: 20, backgroundColor: brand.accent, alignItems: 'center', justifyContent: 'center' },
  introMarkText: { color: brand.petroleumDark, fontSize: 24 },
  introText: { flex: 1, gap: 3 }, introTitle: { fontFamily: 'Inter_600SemiBold', color: 'white', fontSize: 15 }, introSubtitle: { fontFamily: 'Inter_400Regular', color: '#C9D9DD', fontSize: 12 },
  dailyGoalCard: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: 'white', borderRadius: 17, borderWidth: 1, borderColor: brand.border, padding: 15 }, dailyGoalCopy: { flex: 1, gap: 3 }, dailyGoalValue: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 24 }, dailyGoalMuted: { fontFamily: 'Inter_500Medium', color: brand.muted, fontSize: 13 }, streakRule: { fontFamily: 'Inter_400Regular', color: brand.muted, fontSize: 10, lineHeight: 14 },
  progressCard: { backgroundColor: 'white', borderRadius: 17, padding: 16, borderWidth: 1, borderColor: brand.border },
  progressHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  progressTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 18, color: brand.text }, progressSubtitle: { fontFamily: 'Inter_400Regular', fontSize: 12, color: brand.muted, marginTop: 3 },
  progressHighlight: { fontFamily: 'Inter_600SemiBold', fontSize: 35, color: brand.petroleum },
  periodSwitch: { flexDirection: 'row', backgroundColor: brand.surface, borderRadius: 11, padding: 3, marginTop: 12 },
  periodButton: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 9, minHeight: 48, borderRadius: 9 }, periodButtonActive: { backgroundColor: brand.petroleum },
  periodText: { fontFamily: 'Inter_500Medium', fontSize: 12, color: brand.muted }, periodTextActive: { color: 'white' },
  chart: { height: 112, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 2, marginTop: 10 },
  chartColumn: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: 112 }, chartCount: { fontFamily: 'Inter_400Regular', fontSize: 9, color: brand.muted, height: 13 },
  chartTrack: { height: 76, width: '64%', justifyContent: 'flex-end', alignItems: 'center' }, chartBar: { width: '100%', borderRadius: 5 },
  chartLabel: { fontFamily: 'Inter_400Regular', fontSize: 8, color: brand.muted, height: 13, marginTop: 4 },
  motivation: { fontFamily: 'Inter_400Regular', fontSize: 12, lineHeight: 17, color: brand.muted, marginTop: 8, textAlign: 'center' },
  missionCard: { backgroundColor: 'white', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: brand.border, gap: 9 }, weeklySummaryCard: { backgroundColor: '#FFFAEF', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#EAD8A8', gap: 5 }, weeklySummaryValue: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 14, marginTop: 3 }, metricsCard: { backgroundColor: 'white', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: brand.border, gap: 10 }, metricsGrid: { flexDirection: 'row', justifyContent: 'space-between' }, metricValue: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 18, marginTop: 3 }, earnings: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 12, marginTop: 2 },
  missionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, sectionTitle: { fontFamily: 'Inter_600SemiBold', fontSize: 16, color: brand.text }, missionIcon: { color: brand.accent, fontSize: 26 },
  missionTargetRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 2 }, missionTarget: { fontFamily: 'Inter_600SemiBold', fontSize: 28, color: brand.petroleum }, missionTargetMuted: { fontFamily: 'Inter_500Medium', color: brand.muted, fontSize: 13 }, missionPercent: { marginLeft: 'auto', fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 13 },
  missionTrack: { height: 8, borderRadius: 5, backgroundColor: brand.petroleumLight, overflow: 'hidden' }, missionFill: { height: '100%', backgroundColor: brand.accent, borderRadius: 5 },
  statTiles: { flexDirection: 'row', gap: 9 }, statTile: { flex: 1, minHeight: 74, borderRadius: 14, backgroundColor: 'white', borderWidth: 1, borderColor: brand.border, padding: 12, justifyContent: 'center', gap: 3 }, statTileValue: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 22 }, statTileLabel: { fontFamily: 'Inter_400Regular', color: brand.muted, fontSize: 10 },
  deliveryHeader: { paddingHorizontal: 18, paddingTop: 6, paddingBottom: 4 }, syncButton: { backgroundColor: brand.petroleum, paddingVertical: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center', minHeight: 48 },
  deliveryTabs: { flexDirection: 'row', gap: 6, backgroundColor: '#E9EFF1', borderRadius: 12, padding: 4, marginTop: 14 },
  deliveryTab: { flex: 1, borderRadius: 9, paddingVertical: 9, paddingHorizontal: 10, minHeight: 48, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 7 }, deliveryTabActive: { backgroundColor: brand.petroleum },
  deliveryTabText: { fontFamily: 'Inter_600SemiBold', color: brand.muted, fontSize: 13 }, deliveryTabTextActive: { color: 'white' }, deliveryTabCount: { fontFamily: 'Inter_600SemiBold', color: brand.muted, fontSize: 10, opacity: 0.85 },
  datePickerButton: { flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: 'white', borderWidth: 1, borderColor: brand.border, borderRadius: 13, padding: 12, marginTop: 12 },
  calendarGlyph: { width: 38, height: 38, borderRadius: 12, backgroundColor: brand.petroleumLight, alignItems: 'center', justifyContent: 'center' }, calendarGlyphText: { fontSize: 22, color: brand.petroleum },
  datePickerInfo: { flex: 1, gap: 2 }, datePickerCaption: { fontFamily: 'Inter_600SemiBold', fontSize: 9, letterSpacing: 1, color: brand.muted }, datePickerValue: { fontFamily: 'Inter_600SemiBold', fontSize: 13, color: brand.text, textTransform: 'capitalize' }, datePickerChange: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 12 },
  dateStepper: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 3 }, dayStepButton: { paddingVertical: 8, paddingHorizontal: 3, minHeight: 48, justifyContent: 'center' }, dayStepText: { fontFamily: 'Inter_500Medium', color: brand.petroleum, fontSize: 11 }, todayButton: { minHeight: 48, paddingVertical: 6, paddingHorizontal: 13, borderRadius: 20, backgroundColor: '#E9EFF1', justifyContent: 'center' }, todayText: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 11 }, dateHint: { fontFamily: 'Inter_400Regular', color: brand.muted, fontSize: 11, marginTop: 1 }, deliveryCount: { fontFamily: 'Inter_600SemiBold', color: brand.text, fontSize: 13, marginTop: 12 },
  list: { paddingHorizontal: 18, paddingBottom: 18 }, listEmpty: { flexGrow: 1, paddingHorizontal: 18, paddingBottom: 20 }, deliveryCard: { backgroundColor: 'white', padding: 17, borderRadius: 15, marginTop: 10, gap: 8, borderWidth: 1, borderColor: '#EDF0F2' }, quickActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 3 }, quickAction: { minHeight: 48, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: brand.border, justifyContent: 'center', backgroundColor: '#F8FBFB' }, quickActionText: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 12 }, groupSummary: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 12, paddingVertical: 10 }, groupedDeliveryList: { gap: 4, padding: 9, backgroundColor: brand.petroleumLight, borderRadius: 10 }, groupedDeliveryText: { fontFamily: 'Inter_400Regular', color: brand.text, fontSize: 12 },
  cardHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }, cardTitleGroup: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }, name: { flex: 1, fontFamily: 'Inter_600SemiBold', fontSize: 16, color: brand.text }, cardStatusGroup: { alignItems: 'flex-end', gap: 5 },
  routeSelectedCard: { borderColor: brand.petroleum, borderWidth: 2, backgroundColor: '#F8FBFB' }, routeOrderBadge: { width: 25, height: 25, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: brand.petroleum }, routeOrderBadgeText: { fontFamily: 'Inter_600SemiBold', color: 'white', fontSize: 12 },
  addressLine: { fontFamily: 'Inter_400Regular', color: '#3F535D', fontSize: 12, lineHeight: 18 }, schedule: { fontFamily: 'Inter_400Regular', color: brand.muted, fontSize: 11 }, status: { fontFamily: 'Inter_600SemiBold', color: '#2A7A8C', fontSize: 12 }, overdueBadge: { color: '#A44C12', backgroundColor: '#FFF0DF', fontFamily: 'Inter_600SemiBold', fontSize: 9, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  emptyCard: { backgroundColor: 'white', borderRadius: 16, padding: 22, alignItems: 'center', marginTop: 24, gap: 6, borderWidth: 1, borderColor: brand.border }, emptyIcon: { fontSize: 28, color: brand.petroleum }, emptyTitle: { fontFamily: 'Inter_600SemiBold', color: brand.text, fontSize: 15, textAlign: 'center' }, empty: { fontFamily: 'Inter_400Regular', textAlign: 'center', marginTop: 4, color: brand.muted, fontSize: 12, lineHeight: 18 },
  profileHero: { backgroundColor: 'white', borderRadius: 17, overflow: 'hidden', borderWidth: 1, borderColor: brand.border }, coverFrame: { height: 135, position: 'relative' }, coverImage: { width: '100%', height: '100%', resizeMode: 'cover' }, coverPlaceholder: { flex: 1, backgroundColor: brand.petroleumDark, justifyContent: 'center', paddingLeft: 18 }, coverDecoration: { fontFamily: 'Inter_600SemiBold', fontSize: 9, letterSpacing: 2, color: '#A4C5CD' }, coverMessage: { fontFamily: 'Inter_600SemiBold', fontSize: 21, color: 'white', marginTop: 5 }, coverEditButton: { position: 'absolute', right: 10, top: 10, minHeight: 48, paddingHorizontal: 11, paddingVertical: 7, borderRadius: 16, backgroundColor: '#072A35CC', justifyContent: 'center' }, coverEditText: { color: 'white', fontFamily: 'Inter_500Medium', fontSize: 10 },
  profileIdentity: { flexDirection: 'row', alignItems: 'center', gap: 13, padding: 14, marginTop: -3 }, avatarButton: { position: 'relative', marginTop: -28 }, avatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: brand.petroleumLight, borderWidth: 3, borderColor: 'white' }, avatarPlaceholder: { width: 64, height: 64, borderRadius: 32, backgroundColor: brand.petroleumLight, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: 'white' }, avatarInitial: { fontFamily: 'Inter_600SemiBold', fontSize: 25, color: brand.petroleum }, cameraBadge: { position: 'absolute', right: 0, bottom: 0, width: 22, height: 22, borderRadius: 11, backgroundColor: brand.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'white' }, cameraText: { fontFamily: 'Inter_600SemiBold', fontSize: 16, lineHeight: 18, color: brand.text }, profileIdentityText: { flex: 1, paddingTop: 4 }, profileName: { fontFamily: 'Inter_600SemiBold', fontSize: 17, color: brand.text }, profileCaption: { fontFamily: 'Inter_400Regular', fontSize: 12, color: brand.muted, marginTop: 3 },
  teamRankCard: { backgroundColor: 'white', borderRadius: 17, padding: 16, borderWidth: 1, borderColor: brand.border, marginTop: 12 }, teamRankHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }, teamRankRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 58, borderTopWidth: 1, borderTopColor: '#EEF1F2', paddingVertical: 7, paddingHorizontal: 5 }, teamRankRowMe: { backgroundColor: '#F2F7F7', borderRadius: 12, borderTopColor: 'transparent', paddingHorizontal: 9 }, teamRankPosition: { width: 22, textAlign: 'center', fontFamily: 'Inter_600SemiBold', color: brand.muted, fontSize: 14 }, teamRankPositionFirst: { color: '#A67717', fontSize: 17 }, teamRankAvatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: brand.petroleumLight, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, teamRankAvatarImage: { width: 38, height: 38, borderRadius: 19 }, teamRankAvatarInitial: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 15 }, teamRankInfo: { flex: 1 }, teamRankName: { fontFamily: 'Inter_600SemiBold', color: brand.text, fontSize: 13 }, teamRankDeliveries: { fontFamily: 'Inter_400Regular', color: brand.muted, fontSize: 11, marginTop: 2 }, teamRankEmpty: { fontFamily: 'Inter_400Regular', color: brand.muted, fontSize: 12, paddingVertical: 13 }, teamRankFootnote: { fontFamily: 'Inter_400Regular', color: brand.muted, fontSize: 10, marginTop: 9 },
  sectionCard: { backgroundColor: 'white', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: brand.border }, fieldLabel: { fontFamily: 'Inter_500Medium', fontSize: 12, color: brand.text, marginTop: 14, marginBottom: 6 }, seasonalAwardGrid: { flexDirection: 'row', gap: 9, marginBottom: 3 }, seasonalAwardCard: { flex: 1, minWidth: 0, minHeight: 192, borderRadius: 16, backgroundColor: 'white', borderWidth: 1, borderColor: brand.border, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 11, gap: 3 }, seasonalAwardCardWon: { backgroundColor: '#FFFBF0', borderColor: '#D6A94F', shadowColor: '#765014', shadowOpacity: 0.13, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 2 }, seasonalAwardText: { alignItems: 'center', gap: 2, width: '100%' }, seasonalAwardTitle: { fontFamily: 'Inter_600SemiBold', color: brand.text, fontSize: 11, textAlign: 'center' }, seasonalAwardStatus: { fontFamily: 'Inter_600SemiBold', color: brand.muted, fontSize: 9, textAlign: 'center' }, seasonalAwardStatusWon: { color: '#8A6218' }, seasonalAwardSummary: { fontFamily: 'Inter_400Regular', color: brand.text, fontSize: 9, textAlign: 'center', lineHeight: 13 }, seasonalAwardReset: { fontFamily: 'Inter_400Regular', color: brand.muted, fontSize: 8, textAlign: 'center' }, missionSectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }, medalCount: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, fontSize: 13 }, badgeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 }, badgeCard: { width: '48%', minHeight: 132, borderRadius: 15, backgroundColor: '#EEF1F2', borderWidth: 1, borderColor: '#E2E7E9', alignItems: 'center', justifyContent: 'center', padding: 10, gap: 5 }, badgeCardUnlocked: { backgroundColor: '#FFFAEF', borderColor: '#EAD8A8' }, badgeSeal: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#DCE3E5', alignItems: 'center', justifyContent: 'center' }, badgeSealUnlocked: { backgroundColor: '#F0D896' }, badgeSealText: { fontSize: 23, color: brand.petroleum }, badgeTitle: { fontFamily: 'Inter_600SemiBold', color: brand.text, fontSize: 12, textAlign: 'center' }, badgeLockedText: { color: '#75838A' }, badgeHint: { fontFamily: 'Inter_400Regular', color: brand.muted, fontSize: 9, textAlign: 'center' }, badgeTrack: { width: '100%', height: 4, borderRadius: 2, backgroundColor: '#DCE3E5', overflow: 'hidden' }, badgeFill: { height: '100%', borderRadius: 2, backgroundColor: brand.accent }, missionCopy: { fontFamily: 'Inter_400Regular', color: brand.muted, fontSize: 12, lineHeight: 18 },
  settingsIntro: { backgroundColor: brand.petroleumLight, borderRadius: 15, padding: 15, flexDirection: 'row', alignItems: 'center', gap: 12 }, settingsIcon: { width: 40, height: 40, borderRadius: 13, backgroundColor: 'white', alignItems: 'center', justifyContent: 'center' }, settingsIconText: { color: brand.petroleum, fontSize: 23 }, settingsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }, settingsRowLabel: { fontFamily: 'Inter_500Medium', fontSize: 13, color: brand.text }, settingsState: { fontFamily: 'Inter_600SemiBold', fontSize: 12, color: '#A44C12' }, settingsStateOn: { color: brand.success }, settingsFootnote: { fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 17, color: brand.muted, marginTop: 9 }, settingsGap: { marginTop: 14 }, logoutButton: { minHeight: 48, padding: 14, borderRadius: 11, alignItems: 'center', borderWidth: 1, borderColor: '#E8C9C5', backgroundColor: '#FFF8F7' }, logoutButtonText: { fontFamily: 'Inter_600SemiBold', color: brand.danger, fontSize: 13 },
  dock: { flexDirection: 'row', paddingHorizontal: 8, paddingTop: 7, paddingBottom: 4, backgroundColor: 'white', borderTopWidth: 1, borderTopColor: brand.border, justifyContent: 'space-around' }, dockItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, minHeight: 53 }, dockIconWrap: { minWidth: 53, height: 29, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }, dockIconWrapSelected: { backgroundColor: brand.petroleumLight }, dockLabel: { fontFamily: 'Inter_500Medium', fontSize: 10, color: brand.muted }, dockLabelSelected: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum },
  modalBackdrop: { flex: 1, backgroundColor: '#072A3580', justifyContent: 'center', alignItems: 'center', padding: 22 }, calendarCard: { width: '100%', maxWidth: 390, backgroundColor: 'white', borderRadius: 20, padding: 20 }, calendarEyebrow: { fontFamily: 'Inter_600SemiBold', fontSize: 9, letterSpacing: 1.6, color: brand.muted, textAlign: 'center' }, calendarHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 13, marginBottom: 8 }, calendarArrow: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24, backgroundColor: brand.surface }, calendarArrowText: { color: brand.petroleum, fontSize: 27, lineHeight: 30 }, calendarMonth: { fontFamily: 'Inter_600SemiBold', color: brand.text, fontSize: 16, textTransform: 'capitalize' }, calendarGrid: { flexDirection: 'row', flexWrap: 'wrap' }, weekday: { width: '14.2857%', textAlign: 'center', color: brand.muted, fontFamily: 'Inter_600SemiBold', fontSize: 11, paddingVertical: 10 }, calendarDay: { width: '14.2857%', height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 24, borderWidth: 1, borderColor: 'transparent' }, calendarDaySelected: { backgroundColor: brand.petroleum }, calendarDayToday: { borderColor: brand.accent }, calendarDayText: { fontFamily: 'Inter_500Medium', color: brand.text, fontSize: 13 }, calendarDayTextSelected: { color: 'white', fontFamily: 'Inter_600SemiBold' }, calendarActions: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }, calendarToday: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum, padding: 9, minHeight: 48, textAlignVertical: 'center' }, calendarClose: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: brand.petroleumLight, borderRadius: 10, justifyContent: 'center' }, calendarCloseText: { fontFamily: 'Inter_600SemiBold', color: brand.petroleum },
  teamRankPositionText: { fontFamily: 'Inter_600SemiBold', color: brand.muted, fontSize: 14 }, rankEncouragement: { fontFamily: 'Inter_500Medium', color: brand.petroleum, fontSize: 12, lineHeight: 17, marginTop: 10, textAlign: 'center' }, pendingText: { fontFamily: 'Inter_400Regular', color: brand.warning, marginTop: 8, fontSize: 12 }, errorCard: { backgroundColor: '#FFF0ED', padding: 13, borderRadius: 10, marginTop: 9 }, errorText: { fontFamily: 'Inter_500Medium', color: brand.danger, fontSize: 12 },
});
