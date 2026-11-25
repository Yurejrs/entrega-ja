import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { DbPools, Identity } from '../db.js';
import type { ApiConfig } from '../config.js';
import { withTenant } from '../db.js';
import { authenticate, createInvite } from '../auth.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { preparePhoto, readPhoto, removePhoto, savePhoto } from '../storage.js';
import { nearbyMapPlaces, parseOverpass } from '../openstreetmap.js';

const uuid = { type: 'string', format: 'uuid' };
const email = { type: 'string', format: 'email' };

async function admin(request: FastifyRequest, pools: DbPools): Promise<Identity> {
  const { identity } = await authenticate(request, pools);
  if (identity.role !== 'admin' || identity.scope !== 'tenant') forbidden();
  return identity;
}

async function tenantId(client: PoolClient): Promise<string> {
  const result = await client.query<{ tenant_id: string }>('SELECT app.current_tenant_id() AS tenant_id');
  return result.rows[0]!.tenant_id;
}

async function geocodeAddress(address: { street: string; number?: string; neighborhood?: string; city: string; state: string; postalCode?: string }) {
  const query = [address.street, address.number, address.neighborhood, address.city, address.state, address.postalCode, 'Brasil'].filter(Boolean).join(', ');
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'EntregaJa/1.0.0 (address geocoding; support@entregaja.app)', 'Accept-Language': 'pt-BR' }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const rows = await response.json() as Array<{ lat?: string; lon?: string }>;
    const latitude = Number(rows[0]?.lat), longitude = Number(rows[0]?.lon);
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
  } catch { return null; }
}

export function registerTenantRoutes(app: FastifyInstance, pools: DbPools, config: ApiConfig): void {
  app.get('/v1/tenant/delivery-items', {schema:{tags:['tenant'],querystring:{type:'object',properties:{search:{type:'string',maxLength:100},limit:{type:'integer',minimum:1,maximum:200}}}}},async request=>{
    const identity=await admin(request,pools);const q=request.query as {search?:string;limit?:number};
    return withTenant(pools,identity,async client=>{const result=await client.query(`SELECT id,name,icon_key,created_at FROM app.tenant_delivery_items WHERE archived_at IS NULL AND ($1::text IS NULL OR name ILIKE '%'||$1||'%') ORDER BY name LIMIT $2`,[q.search??null,q.limit??100]);return {items:result.rows};});
  });
  app.post('/v1/tenant/delivery-items',{schema:{tags:['tenant'],body:{type:'object',required:['name','iconKey'],properties:{name:{type:'string',minLength:1,maxLength:100},iconKey:{enum:['market','gas','water','box','food','medicine','document','other']}},additionalProperties:false}}},async(request,reply)=>{
    const identity=await admin(request,pools);const body=request.body as {name:string;iconKey:string};
    const item=await withTenant(pools,identity,async client=>{const existing=await client.query('SELECT 1 FROM app.tenant_delivery_items WHERE lower(name)=lower($1) AND archived_at IS NULL',[body.name.trim()]);if(existing.rowCount)conflict('Já existe um volume com esse nome');const result=await client.query(`INSERT INTO app.tenant_delivery_items(tenant_id,name,icon_key) VALUES(app.current_tenant_id(),$1,$2) RETURNING id,name,icon_key,created_at`,[body.name.trim(),body.iconKey]);return result.rows[0];});reply.status(201);return item;
  });
  app.patch('/v1/tenant/delivery-items/:id',{schema:{tags:['tenant'],params:{type:'object',required:['id'],properties:{id:uuid}},body:{type:'object',minProperties:1,properties:{name:{type:'string',minLength:1,maxLength:100},iconKey:{enum:['market','gas','water','box','food','medicine','document','other']},archived:{type:'boolean'}},additionalProperties:false}}},async request=>{
    const identity=await admin(request,pools);const {id}=request.params as {id:string};const body=request.body as {name?:string;iconKey?:string;archived?:boolean};
    return withTenant(pools,identity,async client=>{const result=await client.query(`UPDATE app.tenant_delivery_items SET icon_key=coalesce($4,icon_key),name=coalesce($1,name),archived_at=CASE WHEN $2::boolean IS NULL THEN archived_at WHEN $2 THEN now() ELSE NULL END,updated_at=now() WHERE id=$3 RETURNING id,name,icon_key,archived_at`,[body.name?.trim()??null,body.archived??null,id,body.iconKey??null]);return result.rows[0]??notFound();});
  });
  app.get('/v1/tenant/localities', {schema:{tags:['tenant'],querystring:{type:'object',properties:{search:{type:'string',maxLength:120},category:{enum:['street','neighborhood','locality']},limit:{type:'integer',minimum:1,maximum:200}}}}}, async request=>{
    const identity=await admin(request,pools);const q=request.query as {search?:string;category?:string;limit?:number};
    return withTenant(pools,identity,async client=>{const rows=await client.query(`SELECT category,name FROM app.tenant_localities WHERE ($1::text IS NULL OR category=$1) AND ($2::text IS NULL OR name ILIKE '%'||$2||'%') ORDER BY category,name LIMIT $3`,[q.category??null,q.search??null,q.limit??100]);return {items:rows.rows};});
  });
  app.post('/v1/tenant/localities/import', {schema:{tags:['tenant'],body:{type:'object',required:['location','radiusM'],properties:{location:{type:'string',minLength:3,maxLength:200},radiusM:{type:'integer',minimum:500,maximum:5000}},additionalProperties:false}}},async request=>{
    const identity=await admin(request,pools);const {location,radiusM}=request.body as {location:string;radiusM:number};
    let geo:Response;try{geo=await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(location)}`,{headers:{'User-Agent':'EntregaJa/1.0.0 (locality catalog; support@entregaja.app)','Accept-Language':'pt-BR'},signal:AbortSignal.timeout(15000)});}catch{throw new ApiError(502,'MAP_PROVIDER_UNAVAILABLE','Não foi possível consultar o OpenStreetMap agora');}
    if(!geo.ok)throw new ApiError(502,'MAP_PROVIDER_UNAVAILABLE','Serviço de geocodificação indisponível');const matches=await geo.json() as Array<{lat:string;lon:string}>;if(!matches.length)badRequest('Localidade não encontrada; informe cidade e estado');
    const lat=Number(matches[0]!.lat),lon=Number(matches[0]!.lon);const query=`[out:json][timeout:25];(way(around:${radiusM},${lat},${lon})[highway][name];node(around:${radiusM},${lat},${lon})[place];way(around:${radiusM},${lat},${lon})[place];);out center tags;`;
    let places;
    try {
      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method:'POST', body:new URLSearchParams({data:query}), signal:AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error();
      places = parseOverpass((await response.json()).elements);
    } catch {
      try { places = await nearbyMapPlaces(lat,lon,radiusM); }
      catch { throw new ApiError(502,'MAP_PROVIDER_UNAVAILABLE','Não foi possível consultar as ruas agora. Tente novamente em instantes.'); }
    }
    if (!places.length) badRequest('Nenhuma rua ou localidade encontrada nesse raio. Tente ampliar a área.');
    const saved=await withTenant(pools,identity,async client=>{await client.query(`INSERT INTO app.tenant_operating_areas(tenant_id,location_query,center_latitude,center_longitude,radius_m,imported_at) VALUES(app.current_tenant_id(),$1,$2,$3,$4,now()) ON CONFLICT(tenant_id) DO UPDATE SET location_query=EXCLUDED.location_query,center_latitude=EXCLUDED.center_latitude,center_longitude=EXCLUDED.center_longitude,radius_m=EXCLUDED.radius_m,imported_at=now()`,[location,lat,lon,radiusM]);await client.query('DELETE FROM app.tenant_localities');if(places.length)await client.query(`INSERT INTO app.tenant_localities(tenant_id,source_element,category,name,latitude,longitude) SELECT app.current_tenant_id(),x.source_element,x.category,x.name,x.latitude,x.longitude FROM jsonb_to_recordset($1::jsonb) AS x(source_element text,category text,name text,latitude numeric,longitude numeric) ON CONFLICT(tenant_id,source_element) DO UPDATE SET category=EXCLUDED.category,name=EXCLUDED.name,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,imported_at=now()`,[JSON.stringify(places.map(p => ({...p,source_element:p.sourceElement})))]);return places.length;});
    return {imported:saved,location,radiusM,attribution:'© OpenStreetMap contributors'};
  });
  app.get('/v1/tenant/settings', { schema: { tags: ['tenant'] } }, async request => {
    const identity = await admin(request,pools);
    return withTenant(pools,identity,async client => {
      const result = await client.query('SELECT id,name,legal_name,cnpj,contact_email,status FROM app.tenants');
      return result.rows[0] ?? notFound();
    });
  });

  app.patch('/v1/tenant/settings', { schema: { tags: ['tenant'], body: { type: 'object',
    required: ['contactEmail'], properties: { contactEmail: { type: ['string','null'] } },
    additionalProperties: false } } }, async request => {
    const identity = await admin(request,pools);
    const { contactEmail } = request.body as { contactEmail: string | null };
    if (contactEmail !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) badRequest('E-mail inválido');
    return withTenant(pools,identity,async client => {
      const result = await client.query(`UPDATE app.tenants SET contact_email=$1,updated_at=now()
        WHERE id=app.current_tenant_id() RETURNING id,name,contact_email`,[contactEmail]);
      await client.query(`INSERT INTO app.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id)
        VALUES (app.current_tenant_id(),$1,'tenant.contact_updated','tenant',app.current_tenant_id())`,[identity.userId]);
      return result.rows[0];
    });
  });

  app.get('/v1/tenant/gamification', { schema: { tags: ['tenant'] } }, async request => {
    const identity = await admin(request,pools);
    return withTenant(pools,identity,async client => {
      await client.query(`INSERT INTO app.problem_reasons(tenant_id,code,label,sort_order)
        SELECT app.current_tenant_id(),v.code,v.label,v.sort_order FROM (VALUES
          ('customer_absent','Cliente ausente',1),('address_not_found','Endereço não encontrado',2),
          ('customer_refused','Cliente recusou',3),('other','Outro',4)
        ) AS v(code,label,sort_order) ON CONFLICT (tenant_id,code) DO NOTHING`);
      const settings = await client.query(`SELECT daily_goal,celebration_enabled FROM app.gamification_settings WHERE tenant_id=app.current_tenant_id()`);
      const badges = await client.query(`SELECT id,name,description,target,active FROM app.gamification_badges WHERE tenant_id=app.current_tenant_id() ORDER BY target,name`);
      const reasons = await client.query(`SELECT id,code,label,active,sort_order FROM app.problem_reasons WHERE tenant_id=app.current_tenant_id() ORDER BY sort_order,label`);
      const challenges = await client.query(`SELECT id,name,description,target,bonus_cents,starts_at,ends_at,active FROM app.gamification_challenges WHERE tenant_id=app.current_tenant_id() ORDER BY starts_at DESC,name`);
      const periods = await client.query<{ today: string; week_start: string; month_start: string; tomorrow: string }>(`WITH local AS (
        SELECT (now() AT TIME ZONE 'America/Fortaleza')::date AS today,
          date_trunc('week',now() AT TIME ZONE 'America/Fortaleza')::date AS week_start,
          date_trunc('month',now() AT TIME ZONE 'America/Fortaleza')::date AS month_start
      ) SELECT today::text,week_start::text,month_start::text,(today+1)::text AS tomorrow FROM local`);
      const period = periods.rows[0]!;
      const summary = await client.query<{ today: string; week: string; month: string; active_couriers: string }>(`SELECT
        count(*) FILTER (WHERE d.completed_at >= $1::date AT TIME ZONE 'America/Fortaleza' AND d.completed_at < $2::date AT TIME ZONE 'America/Fortaleza')::text AS today,
        count(*) FILTER (WHERE d.completed_at >= $3::date AT TIME ZONE 'America/Fortaleza' AND d.completed_at < $2::date AT TIME ZONE 'America/Fortaleza')::text AS week,
        count(*) FILTER (WHERE d.completed_at >= $4::date AT TIME ZONE 'America/Fortaleza' AND d.completed_at < $2::date AT TIME ZONE 'America/Fortaleza')::text AS month,
        (SELECT count(*) FROM app.tenant_memberships m JOIN app.users u ON u.id=m.user_id WHERE m.tenant_id=app.current_tenant_id() AND m.role='courier' AND m.status='active' AND u.disabled_at IS NULL)::text AS active_couriers
        FROM app.deliveries d WHERE d.tenant_id=app.current_tenant_id() AND d.status='completed'`,
        [period.today,period.tomorrow,period.week_start,period.month_start]);
      const leaderboard = await client.query(`WITH totals AS (
        SELECT m.id AS membership_id,u.full_name,
          count(d.id) FILTER (WHERE d.completed_at >= $1::date AT TIME ZONE 'America/Fortaleza' AND d.completed_at < $2::date AT TIME ZONE 'America/Fortaleza')::int AS week_completed,
          count(d.id) FILTER (WHERE d.completed_at >= $3::date AT TIME ZONE 'America/Fortaleza' AND d.completed_at < $2::date AT TIME ZONE 'America/Fortaleza')::int AS month_completed
        FROM app.tenant_memberships m JOIN app.users u ON u.id=m.user_id
        LEFT JOIN app.deliveries d ON d.tenant_id=m.tenant_id AND d.courier_membership_id=m.id AND d.status='completed'
        WHERE m.tenant_id=app.current_tenant_id() AND m.role='courier' AND m.status='active' AND u.disabled_at IS NULL
        GROUP BY m.id,u.full_name
      ), ranked AS (SELECT *,rank() OVER (ORDER BY week_completed DESC) AS week_rank,rank() OVER (ORDER BY month_completed DESC) AS month_rank FROM totals)
      SELECT membership_id,full_name,week_completed,month_completed,week_rank,month_rank FROM ranked ORDER BY week_completed DESC,month_completed DESC,lower(full_name) LIMIT 100`,
        [period.week_start,period.tomorrow,period.month_start]);
      const badgeProgress = await client.query(`SELECT b.id,b.name,b.target,
        count(DISTINCT m.id)::int AS total_couriers,
        count(DISTINCT m.id) FILTER (WHERE completed.total >= b.target)::int AS unlocked_couriers,
        coalesce(round(avg(least(b.target,completed.total))),0)::int AS average_progress
        FROM app.gamification_badges b
        LEFT JOIN app.tenant_memberships m ON m.tenant_id=b.tenant_id AND m.role='courier' AND m.status='active'
        LEFT JOIN LATERAL (SELECT count(*)::int AS total FROM app.deliveries d WHERE d.tenant_id=b.tenant_id AND d.courier_membership_id=m.id AND d.status='completed') completed ON true
        WHERE b.tenant_id=app.current_tenant_id() AND b.active GROUP BY b.id,b.name,b.target ORDER BY b.target,b.name`);
      const activeChallenge = await client.query(`SELECT c.id,c.name,c.description,c.target,c.bonus_cents,c.starts_at,c.ends_at,
        count(d.id)::int AS completed
        FROM app.gamification_challenges c LEFT JOIN app.deliveries d ON d.tenant_id=c.tenant_id AND d.status='completed'
          AND (d.completed_at AT TIME ZONE 'America/Fortaleza')::date BETWEEN c.starts_at AND c.ends_at
        WHERE c.tenant_id=app.current_tenant_id() AND c.active
          AND c.starts_at <= (now() AT TIME ZONE 'America/Fortaleza')::date AND c.ends_at >= (now() AT TIME ZONE 'America/Fortaleza')::date
        GROUP BY c.id ORDER BY c.ends_at,c.created_at LIMIT 1`);
      return {
        settings: settings.rows[0] ?? { daily_goal: 10, celebration_enabled: true }, badges: badges.rows, reasons: reasons.rows, challenges: challenges.rows,
        overview: {
          summary: { today: Number(summary.rows[0]?.today ?? 0), week: Number(summary.rows[0]?.week ?? 0), month: Number(summary.rows[0]?.month ?? 0), activeCouriers: Number(summary.rows[0]?.active_couriers ?? 0) },
          leaderboard: leaderboard.rows.map(row => ({ membershipId: row.membership_id, name: row.full_name, weekCompleted: Number(row.week_completed), monthCompleted: Number(row.month_completed), weekRank: Number(row.week_rank), monthRank: Number(row.month_rank) })),
          badgeProgress: badgeProgress.rows.map(row => ({ id: row.id, name: row.name, target: Number(row.target), totalCouriers: Number(row.total_couriers), unlockedCouriers: Number(row.unlocked_couriers), averageProgress: Number(row.average_progress) })),
          activeChallenge: activeChallenge.rows[0] ? { id: activeChallenge.rows[0].id, name: activeChallenge.rows[0].name, description: activeChallenge.rows[0].description, target: Number(activeChallenge.rows[0].target), completed: Number(activeChallenge.rows[0].completed), bonusCents: Number(activeChallenge.rows[0].bonus_cents), startsAt: activeChallenge.rows[0].starts_at, endsAt: activeChallenge.rows[0].ends_at } : null,
        },
      };
    });
  });

  app.patch('/v1/tenant/gamification', { schema: { tags: ['tenant'], body: { type: 'object', minProperties: 1,
    properties: { dailyGoal: { type: 'integer', minimum: 1, maximum: 500 }, celebrationEnabled: { type: 'boolean' } }, additionalProperties: false } } }, async request => {
    const identity = await admin(request,pools);
    const body = request.body as { dailyGoal?: number; celebrationEnabled?: boolean };
    return withTenant(pools,identity,async client => {
      const row = await client.query(`INSERT INTO app.gamification_settings(tenant_id,daily_goal,celebration_enabled)
        VALUES(app.current_tenant_id(),coalesce($1,10),coalesce($2,true))
        ON CONFLICT(tenant_id) DO UPDATE SET daily_goal=coalesce($1,gamification_settings.daily_goal),celebration_enabled=coalesce($2,gamification_settings.celebration_enabled),updated_at=now()
        RETURNING daily_goal,celebration_enabled`,[body.dailyGoal ?? null,body.celebrationEnabled ?? null]);
      return row.rows[0];
    });
  });

  app.post('/v1/tenant/gamification/badges', { schema: { tags: ['tenant'], body: { type: 'object', required: ['name','description','target'], properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, description: { type: 'string', minLength: 1, maxLength: 240 }, target: { type: 'integer', minimum: 1, maximum: 100000 } }, additionalProperties: false } } }, async request => {
    const identity = await admin(request,pools); const body=request.body as {name:string;description:string;target:number};
    return withTenant(pools,identity,async client=>{const result=await client.query(`INSERT INTO app.gamification_badges(tenant_id,name,description,target) VALUES(app.current_tenant_id(),$1,$2,$3) RETURNING id,name,description,target,active`,[body.name.trim(),body.description.trim(),body.target]);return result.rows[0];});
  });
  app.patch('/v1/tenant/gamification/badges/:id', { schema: { tags: ['tenant'], params: { type: 'object', required: ['id'], properties: { id: uuid } }, body: { type: 'object', minProperties: 1, properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, description: { type: 'string', minLength: 1, maxLength: 240 }, target: { type: 'integer', minimum: 1, maximum: 100000 }, active: { type: 'boolean' } }, additionalProperties: false } } }, async request => {
    const identity=await admin(request,pools); const {id}=request.params as {id:string}; const body=request.body as Record<string,unknown>;
    return withTenant(pools,identity,async client=>{const result=await client.query(`UPDATE app.gamification_badges SET name=coalesce($1,name),description=coalesce($2,description),target=coalesce($3,target),active=coalesce($4,active),updated_at=now() WHERE id=$5 RETURNING id,name,description,target,active`,[body.name??null,body.description??null,body.target??null,body.active??null,id]);return result.rows[0]??notFound();});
  });
  app.get('/v1/tenant/gamification/challenges', { schema: { tags: ['tenant'] } }, async request => {
    const identity = await admin(request,pools);
    return withTenant(pools,identity,async client => (await client.query(`SELECT id,name,description,target,bonus_cents,starts_at,ends_at,active FROM app.gamification_challenges ORDER BY starts_at DESC,name`)).rows);
  });
  app.post('/v1/tenant/gamification/challenges', { schema: { tags: ['tenant'], body: { type: 'object', required: ['name','target','startsAt','endsAt'], properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 }, description: { type: 'string', maxLength: 240 }, target: { type: 'integer', minimum: 1, maximum: 100000 }, bonusCents: { type: 'integer', minimum: 0, maximum: 100000000 }, startsAt: { type: 'string', format: 'date' }, endsAt: { type: 'string', format: 'date' }, active: { type: 'boolean' }
  }, additionalProperties: false } } }, async (request,reply) => {
    const identity = await admin(request,pools); const body=request.body as {name:string;description?:string;target:number;bonusCents?:number;startsAt:string;endsAt:string;active?:boolean};
    if(body.endsAt<body.startsAt) badRequest('O período do desafio é inválido');
    const row=await withTenant(pools,identity,async client=>(await client.query(`INSERT INTO app.gamification_challenges(tenant_id,name,description,target,bonus_cents,starts_at,ends_at,active) VALUES(app.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7) RETURNING id,name,description,target,bonus_cents,starts_at,ends_at,active`,[body.name.trim(),body.description?.trim()??'',body.target,body.bonusCents??0,body.startsAt,body.endsAt,body.active??true])).rows[0]); reply.status(201); return row;
  });
  app.patch('/v1/tenant/gamification/challenges/:id', { schema: { tags: ['tenant'], params: { type: 'object', required: ['id'], properties: { id: uuid } }, body: { type: 'object', minProperties: 1, properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, description: { type: 'string', maxLength: 240 }, target: { type: 'integer', minimum: 1, maximum: 100000 }, bonusCents: { type: 'integer', minimum: 0, maximum: 100000000 }, startsAt: { type: 'string', format: 'date' }, endsAt: { type: 'string', format: 'date' }, active: { type: 'boolean' } }, additionalProperties: false } } }, async request => {
    const identity=await admin(request,pools); const {id}=request.params as {id:string}; const body=request.body as Record<string,unknown>;
    if(body.startsAt && body.endsAt && String(body.endsAt)<String(body.startsAt)) badRequest('O período do desafio é inválido');
    return withTenant(pools,identity,async client=>(await client.query(`UPDATE app.gamification_challenges SET name=coalesce($1,name),description=coalesce($2,description),target=coalesce($3,target),bonus_cents=coalesce($4,bonus_cents),starts_at=coalesce($5,starts_at),ends_at=coalesce($6,ends_at),active=coalesce($7,active),updated_at=now() WHERE id=$8 RETURNING id,name,description,target,bonus_cents,starts_at,ends_at,active`,[body.name??null,body.description??null,body.target??null,body.bonusCents??null,body.startsAt??null,body.endsAt??null,body.active??null,id])).rows[0]??notFound());
  });
  app.patch('/v1/tenant/gamification/problem-reasons/:id', { schema: { tags: ['tenant'], params: { type: 'object', required: ['id'], properties: { id: uuid } }, body: { type: 'object', minProperties: 1, properties: { label: { type: 'string', minLength: 1, maxLength: 120 }, active: { type: 'boolean' }, sortOrder: { type: 'integer', minimum: 0, maximum: 10000 } }, additionalProperties: false } } }, async request => {
    const identity=await admin(request,pools); const {id}=request.params as {id:string}; const body=request.body as Record<string,unknown>;
    return withTenant(pools,identity,async client=>(await client.query(`UPDATE app.problem_reasons SET label=coalesce($1,label),active=coalesce($2,active),sort_order=coalesce($3,sort_order) WHERE id=$4 RETURNING id,code,label,active,sort_order`,[body.label??null,body.active??null,body.sortOrder??null,id])).rows[0]??notFound());
  });

  app.get('/v1/tenant/dashboard', { schema: { tags: ['tenant'], querystring: { type: 'object', properties: {
    period: { enum: ['day','week','month'] } } } } }, async request => {
    const identity = await admin(request,pools);
    return withTenant(pools,identity,async client => {
      const { period = 'day' } = request.query as { period?: 'day'|'week'|'month' };
      const counts = await client.query<{ status: string; count: string }>(`SELECT status,count(*)::text AS count
        FROM app.deliveries GROUP BY status`);
      const unseen = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM app.deliveries
        WHERE courier_membership_id IS NOT NULL AND viewed_at IS NULL AND status NOT IN ('completed','cancelled')`);
      const workerHeartbeat = await client.query<{ status: 'active'|'error'|'no_credential'; last_tick_at: string; last_success_at: string | null; last_error_at: string | null; last_error: string | null }>(
        `SELECT status,last_tick_at,last_success_at,last_error_at,last_error FROM app.worker_heartbeats WHERE worker_name='notifications'`);
      const workerQueue = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM app.notification_outbox WHERE status IN ('pending','processing')`);
      const heartbeat = workerHeartbeat.rows[0];
      const heartbeatAge = heartbeat ? Date.now() - new Date(heartbeat.last_tick_at).getTime() : Infinity;
      const workerStatus = !heartbeat ? 'no_heartbeat' : heartbeatAge > 10 * 60 * 1000 ? 'stopped' : heartbeat.status;
      const liveCouriers = await client.query(`SELECT s.courier_membership_id AS sharing_id,m.user_id,u.full_name,
          last.latitude,last.longitude,last.received_at,s.started_at,s.last_seen_at,
          CASE WHEN last.received_at IS NULL THEN 'no_signal'
            WHEN last.received_at < now()-interval '90 seconds' THEN 'stale' ELSE 'ok' END AS gps_status
        FROM app.courier_location_sharing s
        JOIN app.tenant_memberships m ON m.id=s.courier_membership_id
        JOIN app.users u ON u.id=m.user_id
        LEFT JOIN LATERAL (SELECT latitude,longitude,received_at FROM app.courier_locations l
          WHERE l.courier_membership_id=s.courier_membership_id AND l.captured_at>=s.started_at AND l.accuracy_m<=$1 ORDER BY l.captured_at DESC LIMIT 1) last ON true
        WHERE s.status='active' ORDER BY u.full_name`,[config.gpsLowPrecisionThresholdM]);
      const summary = await client.query<{ day: string; week: string; month: string; previous_day: string; previous_week: string; previous_month: string }>(`WITH clock AS (
          SELECT (now() AT TIME ZONE 'America/Fortaleza')::date AS today,
            date_trunc('week',now() AT TIME ZONE 'America/Fortaleza')::date AS week_start,
            date_trunc('month',now() AT TIME ZONE 'America/Fortaleza')::date AS month_start
        ) SELECT
          count(*) FILTER (WHERE d.created_at >= c.today::timestamp AT TIME ZONE 'America/Fortaleza'
            AND d.created_at < (c.today+1)::timestamp AT TIME ZONE 'America/Fortaleza')::text AS day,
          count(*) FILTER (WHERE d.created_at >= c.week_start::timestamp AT TIME ZONE 'America/Fortaleza'
            AND d.created_at < (c.today+1)::timestamp AT TIME ZONE 'America/Fortaleza')::text AS week,
          count(*) FILTER (WHERE d.created_at >= c.month_start::timestamp AT TIME ZONE 'America/Fortaleza'
            AND d.created_at < (c.today+1)::timestamp AT TIME ZONE 'America/Fortaleza')::text AS month,
          count(*) FILTER (WHERE d.created_at >= (c.today-1)::timestamp AT TIME ZONE 'America/Fortaleza'
            AND d.created_at < c.today::timestamp AT TIME ZONE 'America/Fortaleza')::text AS previous_day,
          count(*) FILTER (WHERE d.created_at >= (c.week_start-7)::timestamp AT TIME ZONE 'America/Fortaleza'
            AND d.created_at < c.week_start::timestamp AT TIME ZONE 'America/Fortaleza')::text AS previous_week,
          count(*) FILTER (WHERE d.created_at >= (c.month_start-interval '1 month') AT TIME ZONE 'America/Fortaleza'
            AND d.created_at < c.month_start::timestamp AT TIME ZONE 'America/Fortaleza')::text AS previous_month
        FROM app.deliveries d CROSS JOIN clock c`);
      const series = await client.query<{ label: string; count: number }>(`WITH clock AS (
          SELECT (now() AT TIME ZONE 'America/Fortaleza')::date AS today,
            date_trunc('week',now() AT TIME ZONE 'America/Fortaleza')::date AS week_start,
            date_trunc('month',now() AT TIME ZONE 'America/Fortaleza')::date AS month_start,
            extract(day FROM (date_trunc('month',now() AT TIME ZONE 'America/Fortaleza')
              + interval '1 month - 1 day'))::int AS month_days
        ), buckets AS (
          SELECT (c.today::timestamp + make_interval(hours => h.value)) AS starts_at
          FROM clock c CROSS JOIN generate_series(0,23) AS h(value) WHERE $1='day'
          UNION ALL
          SELECT (c.week_start + d.value)::timestamp
          FROM clock c CROSS JOIN generate_series(0,6) AS d(value) WHERE $1='week'
          UNION ALL
          SELECT (c.month_start + d.value)::timestamp
          FROM clock c CROSS JOIN generate_series(0,c.month_days-1) AS d(value) WHERE $1='month'
        ) SELECT CASE WHEN $1='day' THEN to_char(b.starts_at,'HH24')||'h'
            WHEN $1='week' THEN to_char(b.starts_at,'DD/MM') ELSE to_char(b.starts_at,'DD') END AS label,
          count(d.id)::int AS count
        FROM buckets b LEFT JOIN app.deliveries d ON
          d.created_at >= b.starts_at AT TIME ZONE 'America/Fortaleza' AND
          d.created_at < (b.starts_at + CASE WHEN $1='day' THEN interval '1 hour' ELSE interval '1 day' END)
            AT TIME ZONE 'America/Fortaleza'
        GROUP BY b.starts_at ORDER BY b.starts_at`,[period]);
      return { byStatus: Object.fromEntries(counts.rows.map(row => [row.status,Number(row.count)])),
        unseen: Number(unseen.rows[0]!.count),
        summary: Object.fromEntries(Object.entries(summary.rows[0]!).filter(([key]) => !key.startsWith('previous_')).map(([key,value]) => [key,Number(value)])),
        comparison: { day: Number(summary.rows[0]!.previous_day), week: Number(summary.rows[0]!.previous_week), month: Number(summary.rows[0]!.previous_month) },
        series: { period, items: series.rows }, liveCouriers: liveCouriers.rows,
        worker: { status: workerStatus, lastTickAt: heartbeat?.last_tick_at ?? null, lastSuccessAt: heartbeat?.last_success_at ?? null, lastError: heartbeat?.last_error ?? null, pending: Number(workerQueue.rows[0]!.count) } };
    });
  });

  app.get('/v1/tenant/reports/deliveries.csv', { schema: { tags: ['tenant'], querystring: { type: 'object', properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, courierMembershipId: uuid, neighborhood: { type: 'string', maxLength: 120 }, hourFrom: { type: 'integer', minimum: 0, maximum: 23 }, hourTo: { type: 'integer', minimum: 0, maximum: 23 } } } } }, async (request,reply) => {
    const identity=await admin(request,pools); const q=request.query as {from?:string;to?:string;courierMembershipId?:string;neighborhood?:string;hourFrom?:number;hourTo?:number};
    const esc=(value:unknown)=>`"${String(value??'').replaceAll('"','""')}"`;
    const rows=await withTenant(pools,identity,async client=>(await client.query(`SELECT d.id,c.name AS customer_name,d.status,d.scheduled_for,d.completed_at,u.full_name AS courier_name,
        d.destination_snapshot->>'neighborhood' AS neighborhood,extract(hour FROM d.created_at AT TIME ZONE 'America/Fortaleza')::int AS created_hour
      FROM app.deliveries d JOIN app.customers c ON c.id=d.customer_id LEFT JOIN app.tenant_memberships m ON m.id=d.courier_membership_id LEFT JOIN app.users u ON u.id=m.user_id
      WHERE ($1::date IS NULL OR (d.created_at AT TIME ZONE 'America/Fortaleza')::date >= $1::date) AND ($2::date IS NULL OR (d.created_at AT TIME ZONE 'America/Fortaleza')::date <= $2::date) AND ($3::uuid IS NULL OR d.courier_membership_id=$3) ORDER BY d.created_at DESC`,[q.from??null,q.to??null,q.courierMembershipId??null])).rows);
    const filtered=rows.filter(row => (!q.neighborhood || String(row.neighborhood??'').toLocaleLowerCase('pt-BR').includes(q.neighborhood.toLocaleLowerCase('pt-BR'))) && (q.hourFrom===undefined || Number(row.created_hour)>=q.hourFrom) && (q.hourTo===undefined || Number(row.created_hour)<=q.hourTo));
    const csv=[['ID','Cliente','Status','Agendada para','Concluída em','Entregador','Bairro','Hora de criação'].map(esc).join(';'),...filtered.map(row=>[row.id,row.customer_name,row.status,row.scheduled_for,row.completed_at,row.courier_name,row.neighborhood,row.created_hour].map(esc).join(';'))].join('\n');
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="entregas.csv"').send(csv);
  });
  app.get('/v1/tenant/reports/heatmap', { schema: { tags: ['tenant'], querystring: { type: 'object', properties: { from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' } } } } }, async request => {
    const identity=await admin(request,pools); const q=request.query as {from?:string;to?:string};
    return withTenant(pools,identity,async client=>(await client.query(`SELECT (d.destination_snapshot->>'reference_latitude')::numeric AS latitude,(d.destination_snapshot->>'reference_longitude')::numeric AS longitude,count(*)::int AS weight FROM app.deliveries d WHERE d.status='completed' AND ($1::date IS NULL OR (d.completed_at AT TIME ZONE 'America/Fortaleza')::date >= $1::date) AND ($2::date IS NULL OR (d.completed_at AT TIME ZONE 'America/Fortaleza')::date <= $2::date) AND d.destination_snapshot->>'reference_latitude' IS NOT NULL AND d.destination_snapshot->>'reference_longitude' IS NOT NULL GROUP BY 1,2 ORDER BY weight DESC LIMIT 1000`,[q.from??null,q.to??null])).rows);
  });

  app.get('/v1/tenant/customers', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { tags: ['tenant'], querystring: { type: 'object',
    properties: { cursor: uuid, limit: { type: 'integer', minimum: 1, maximum: 100 }, search: { type: 'string', maxLength: 200 } } } } }, async request => {
    const identity = await admin(request, pools);
    const query = request.query as { cursor?: string; limit?: number; search?: string };
    return withTenant(pools, identity, async client => {
      const result = await client.query(`SELECT id,name,phone,email,notes,archived_at,created_at
        FROM app.customers WHERE ($1::uuid IS NULL OR id < $1)
          AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%')
        ORDER BY id DESC LIMIT $3`, [query.cursor ?? null, query.search ?? null, query.limit ?? 50]);
      return { items: result.rows, nextCursor: result.rows.at(-1)?.id ?? null };
    });
  });

  app.post('/v1/tenant/customers', { schema: { tags: ['tenant'], body: { type: 'object', required: ['name'],
    properties: { name: { type: 'string', minLength: 1 }, phone: { type: 'string' }, email,
      notes: { type: 'string' } }, additionalProperties: false } } }, async (request, reply) => {
    const identity = await admin(request, pools);
    const body = request.body as { name: string; phone?: string; email?: string; notes?: string };
    const row = await withTenant(pools, identity, async client => {
      const result = await client.query(`INSERT INTO app.customers(tenant_id,name,phone,email,notes)
        VALUES (app.current_tenant_id(),$1,$2,$3,$4) RETURNING *`,
        [body.name, body.phone ?? null, body.email ?? null, body.notes ?? null]);
      return result.rows[0];
    });
    reply.status(201); return row;
  });

  app.patch('/v1/tenant/customers/:id', { schema: { tags: ['tenant'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', properties: { name: { type: 'string', minLength: 1 }, phone: { type: ['string','null'] },
      email: { type: ['string','null'] }, notes: { type: ['string','null'] }, archived: { type: 'boolean' } },
      additionalProperties: false, minProperties: 1 } } }, async request => {
    const identity = await admin(request, pools);
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
    const allowed: Record<string, string> = { name: 'name', phone: 'phone', email: 'email', notes: 'notes', archived: 'archived_at' };
    const entries = Object.entries(body);
    const values: unknown[] = [];
    const sets = entries.map(([key, value]) => {
      if (!allowed[key]) badRequest('Campo inválido');
      if (key === 'archived') return `archived_at=${value ? 'now()' : 'NULL'}`;
      values.push(value);
      return `${allowed[key]}=$${values.length}`;
    });
    values.push(id);
    return withTenant(pools, identity, async client => {
      const result = await client.query(`UPDATE app.customers SET ${sets.join(',')},updated_at=now()
        WHERE id=$${values.length} RETURNING *`, values);
      return result.rows[0] ?? notFound();
    });
  });

  app.get('/v1/tenant/addresses', { schema: { tags: ['tenant'], querystring: { type: 'object',
    properties: { customerId: uuid, cursor: uuid, limit: { type: 'integer', minimum: 1, maximum: 100 }, search: { type: 'string', maxLength: 200 } } } } }, async request => {
    const identity = await admin(request, pools);
    const query = request.query as { customerId?: string; cursor?: string; limit?: number; search?: string };
    return withTenant(pools, identity, async client => {
      const result = await client.query(`SELECT a.* FROM app.addresses a
        JOIN app.customers c ON c.id=a.customer_id AND c.tenant_id=a.tenant_id
        WHERE ($1::uuid IS NULL OR a.customer_id=$1) AND ($2::uuid IS NULL OR a.id<$2)
          AND NOT EXISTS (
            SELECT 1 FROM regexp_split_to_table(trim(coalesce($3::text,'')), '[ ,]+') term
            WHERE strpos(lower(concat_ws(' ',c.name,a.label,a.street,a.number,a.complement,
              a.neighborhood,a.city,a.state,a.postal_code,replace(a.postal_code,'-',''))),
              lower(replace(term,'-',''))) = 0
              AND strpos(lower(concat_ws(' ',c.name,a.label,a.street,a.number,a.complement,
                a.neighborhood,a.city,a.state,a.postal_code)),lower(term)) = 0)
        ORDER BY a.id DESC LIMIT $4`, [query.customerId ?? null, query.cursor ?? null, query.search ?? null, query.limit ?? 50]);
      return { items: result.rows, nextCursor: result.rows.at(-1)?.id ?? null };
    });
  });

  app.post('/v1/tenant/addresses', { schema: { tags: ['tenant'], body: { type: 'object',
    required: ['customerId','street','city','state'], properties: { customerId: uuid, label: { type: 'string' },
      street: { type: 'string', minLength: 1 }, number: { type: 'string' }, complement: { type: 'string' },
      neighborhood: { type: 'string' }, city: { type: 'string', minLength: 1 }, state: { type: 'string', minLength: 2, maxLength: 2 },
      postalCode: { type: 'string' }, referenceLatitude: { type: 'number', minimum: -90, maximum: 90 },
      referenceLongitude: { type: 'number', minimum: -180, maximum: 180 } }, additionalProperties: false } } }, async (request, reply) => {
    const identity = await admin(request, pools);
    const b = request.body as Record<string, unknown>;
    const geocoded = b.referenceLatitude === undefined && b.referenceLongitude === undefined
      ? await geocodeAddress({ street: String(b.street), number: b.number ? String(b.number) : undefined, neighborhood: b.neighborhood ? String(b.neighborhood) : undefined, city: String(b.city), state: String(b.state), postalCode: b.postalCode ? String(b.postalCode) : undefined })
      : null;
    const row = await withTenant(pools, identity, async client => {
      const result = await client.query(`INSERT INTO app.addresses(tenant_id,customer_id,label,street,number,complement,
        neighborhood,city,state,postal_code,reference_latitude,reference_longitude,reference_updated_at)
        VALUES (app.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          CASE WHEN $10::numeric IS NULL THEN NULL ELSE now() END) RETURNING *`,
        [b.customerId,b.label ?? null,b.street,b.number ?? null,b.complement ?? null,b.neighborhood ?? null,
        b.city,b.state,b.postalCode ?? null,b.referenceLatitude ?? geocoded?.latitude ?? null,b.referenceLongitude ?? geocoded?.longitude ?? null]);
      return result.rows[0];
    });
    reply.status(201); return row;
  });

  app.patch('/v1/tenant/addresses/:id/location', { schema: { tags: ['tenant'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', required: ['latitude','longitude'], properties: { latitude: { type: 'number', minimum: -90, maximum: 90 },
      longitude: { type: 'number', minimum: -180, maximum: 180 } }, additionalProperties: false } } }, async request => {
    const identity = await admin(request, pools);
    const { id } = request.params as { id: string };
    const { latitude, longitude } = request.body as { latitude: number; longitude: number };
    return withTenant(pools, identity, async client => {
      const result = await client.query(`UPDATE app.addresses SET reference_latitude=$1,reference_longitude=$2,
        reference_updated_at=now(),updated_at=now() WHERE id=$3 RETURNING *`, [latitude, longitude, id]);
      return result.rows[0] ?? notFound();
    });
  });

  app.patch('/v1/tenant/addresses/:id', { schema: { tags: ['tenant'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', minProperties: 1, properties: { label: { type: ['string','null'] }, street: { type: 'string', minLength: 1 },
      number: { type: ['string','null'] }, complement: { type: ['string','null'] }, neighborhood: { type: ['string','null'] },
      city: { type: 'string', minLength: 1 }, state: { type: 'string', minLength: 2, maxLength: 2 },
      postalCode: { type: ['string','null'] }, archived: { type: 'boolean' } }, additionalProperties: false } } }, async request => {
    const identity = await admin(request,pools);
    const { id } = request.params as { id: string };
    const body = request.body as Record<string,unknown>;
    const allowed: Record<string,string> = { label:'label',street:'street',number:'number',complement:'complement',
      neighborhood:'neighborhood',city:'city',state:'state',postalCode:'postal_code' };
    const values: unknown[] = [];
    const sets = Object.entries(body).map(([key,value]) => {
      if (key === 'archived') return `archived_at=${value ? 'now()' : 'NULL'}`;
      if (!allowed[key]) badRequest('Campo inválido');
      values.push(value);
      return `${allowed[key]}=$${values.length}`;
    });
    values.push(id);
    return withTenant(pools,identity,async client => {
      const result = await client.query(`UPDATE app.addresses SET ${sets.join(',')},updated_at=now()
        WHERE id=$${values.length} RETURNING *`,values);
      return result.rows[0] ?? notFound();
    });
  });

  app.get('/v1/tenant/users', { schema: { tags: ['tenant'], querystring: { type: 'object', properties: {
    cursor: uuid, limit: { type: 'integer', minimum: 1, maximum: 100 },
    role: { enum: ['admin','courier'] }, status: { enum: ['active','inactive'] }, search: { type: 'string', maxLength: 200 } } } } }, async request => {
    const identity = await admin(request, pools);
    const q = request.query as { cursor?: string; limit?: number; role?: string; status?: string; search?: string };
    return withTenant(pools, identity, async client => {
      const result = await client.query(`SELECT m.id AS membership_id,m.role,m.status,m.joined_at,
        u.id AS user_id,u.email,u.full_name,u.profile_location,u.profile_photo_key IS NOT NULL AS has_profile_photo FROM app.tenant_memberships m
        JOIN app.users u ON u.id=m.user_id WHERE ($1::uuid IS NULL OR m.id<$1)
          AND ($2::text IS NULL OR m.role=$2) AND ($3::text IS NULL OR m.status=$3)
          AND ($4::text IS NULL OR u.full_name ILIKE '%'||$4||'%' OR u.email ILIKE '%'||$4||'%')
        ORDER BY m.id DESC LIMIT $5`,[q.cursor ?? null,q.role ?? null,q.status ?? null,q.search ?? null,q.limit ?? 50]);
      return { items: result.rows, nextCursor: result.rows.at(-1)?.membership_id ?? null };
    });
  });

  app.patch('/v1/tenant/users/:id/profile', { schema: { tags: ['tenant'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', minProperties: 1, properties: { fullName: { type: 'string', minLength: 1 },
      location: { type: ['string','null'], maxLength: 200 } }, additionalProperties: false } } }, async request => {
    const identity = await admin(request,pools);
    const { id } = request.params as { id: string };
    const body = request.body as { fullName?: string; location?: string | null };
    if (body.fullName !== undefined && !body.fullName.trim()) badRequest('Nome inválido');
    if (body.location !== undefined && body.location !== null && !body.location.trim()) badRequest('Local de atuação inválido');
    return withTenant(pools,identity,async client => {
      const membership = await client.query<{ user_id: string }>(
        'SELECT user_id FROM app.tenant_memberships WHERE id=$1',[id]);
      if (!membership.rows[0]) notFound();
      const sets: string[] = [];
      const values: unknown[] = [];
      if (body.fullName !== undefined) { values.push(body.fullName.trim()); sets.push(`full_name=$${values.length}`); }
      if (body.location !== undefined) { values.push(body.location?.trim() || null); sets.push(`profile_location=$${values.length}`); }
      values.push(membership.rows[0].user_id);
      const result = await client.query(`UPDATE app.users SET ${sets.join(',')},updated_at=now()
        WHERE id=$${values.length} RETURNING id,full_name,profile_location`,values);
      await client.query(`INSERT INTO app.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id)
        VALUES (app.current_tenant_id(),$1,'tenant.user_profile_updated','user',$2)`,
        [identity.userId,membership.rows[0].user_id]);
      return result.rows[0];
    });
  });

  app.put('/v1/tenant/users/:id/photo', { schema: { tags: ['tenant'], params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async request => {
    const identity = await admin(request,pools);
    const { id } = request.params as { id: string };
    let photo: Buffer | null = null;
    let declaredMime = '';
    for await (const part of request.parts()) {
      if (part.type !== 'file' || part.fieldname !== 'photo' || photo) badRequest('Envie uma foto no campo photo');
      declaredMime = part.mimetype;
      photo = await part.toBuffer();
    }
    if (!photo) badRequest('Foto obrigatória');
    const prepared = await preparePhoto(photo,declaredMime);
    let savedKey: string | null = null;
    let oldKey: string | null = null;
    try {
      const result = await withTenant(pools,identity,async client => {
        const membership = await client.query<{ user_id:string; tenant_id:string; old_key:string|null }>(`SELECT m.user_id,m.tenant_id,u.profile_photo_key AS old_key
          FROM app.tenant_memberships m JOIN app.users u ON u.id=m.user_id
          WHERE m.id=$1 AND m.tenant_id=app.current_tenant_id()`,[id]);
        if (!membership.rows[0]) notFound();
        const stored = await savePhoto(config,membership.rows[0].tenant_id,id,prepared.bytes);
        savedKey = stored.key;
        oldKey = membership.rows[0].old_key;
        await client.query('UPDATE app.users SET profile_photo_key=$1,updated_at=now() WHERE id=$2',
          [stored.key,membership.rows[0].user_id]);
        await client.query(`INSERT INTO app.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id)
          VALUES (app.current_tenant_id(),$1,'tenant.user_photo_updated','user',$2)`,[identity.userId,membership.rows[0].user_id]);
        return { updated:true };
      });
      if (oldKey) await removePhoto(config,oldKey);
      return result;
    } catch (error) {
      if (savedKey) await removePhoto(config,savedKey);
      throw error;
    }
  });

  app.get('/v1/tenant/users/:id/photo', { schema: { tags: ['tenant'], params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request,reply) => {
    const identity = await admin(request,pools);
    const { id } = request.params as { id: string };
    const photoKey = await withTenant(pools,identity,async client => {
      const result = await client.query<{ profile_photo_key:string|null }>(`SELECT u.profile_photo_key FROM app.tenant_memberships m
        JOIN app.users u ON u.id=m.user_id WHERE m.id=$1 AND m.tenant_id=app.current_tenant_id()`,[id]);
      return result.rows[0]?.profile_photo_key ?? notFound();
    });
    reply.type('image/jpeg').header('Cache-Control','private, no-store');
    return reply.send(readPhoto(config,photoKey));
  });

  app.post('/v1/tenant/invites', { schema: { tags: ['tenant'], body: { type: 'object', required: ['email','role'],
    properties: { email, role: { enum: ['admin','courier'] } }, additionalProperties: false } } }, async (request, reply) => {
    const identity = await admin(request, pools);
    const { email: address, role } = request.body as { email: string; role: 'admin' | 'courier' };
    const invite = await withTenant(pools, identity, async client => {
      const tenant = await tenantId(client);
      const created = await createInvite(client, {
        email: address, purpose: 'invite', tenantId: tenant, role, actorId: identity.userId,
      });
      await client.query(`INSERT INTO app.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id)
        VALUES (app.current_tenant_id(),$1,'tenant.user_invited','invite',$2)`,[identity.userId,created.id]);
      return created;
    });
    reply.status(201); return invite;
  });

  app.post('/v1/tenant/users/:id/password-reset', { schema: { tags: ['tenant'], params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request, reply) => {
    const identity = await admin(request, pools);
    const { id } = request.params as { id: string };
    const invite = await withTenant(pools, identity, async client => {
      const user = await client.query<{ email: string; is_platform_admin: boolean }>(`SELECT u.email,u.is_platform_admin FROM app.users u
        JOIN app.tenant_memberships m ON m.user_id=u.id WHERE u.id=$1`, [id]);
      if (!user.rows[0]) notFound();
      if (user.rows[0].is_platform_admin) forbidden();
      return createInvite(client, { email: user.rows[0].email, purpose: 'password_reset',
        tenantId: await tenantId(client), actorId: identity.userId });
    });
    reply.status(201); return invite;
  });

  app.patch('/v1/tenant/users/:id/status', { schema: { tags: ['tenant'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', required: ['status'], properties: { status: { enum: ['active','inactive'] } }, additionalProperties: false } } }, async request => {
    const identity = await admin(request, pools);
    const { id } = request.params as { id: string };
    const { status } = request.body as { status: 'active' | 'inactive' };
    return withTenant(pools, identity, async client => {
      if (id === identity.membershipId && status === 'inactive') forbidden();
      const result = await client.query(`UPDATE app.tenant_memberships
        SET status=$1,ended_at=CASE WHEN $1='inactive' THEN now() ELSE NULL END
        WHERE id=$2 RETURNING id,user_id,role,status`, [status, id]);
      if (!result.rows[0]) notFound();
      await client.query(`INSERT INTO app.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,details)
        VALUES (app.current_tenant_id(),$1,'tenant.membership_status_changed','membership',$2,
          jsonb_build_object('status',$3::text))`,[identity.userId,id,status]);
      return result.rows[0];
    });
  });

  app.get('/v1/tenant/live-locations/stream', { schema: { tags: ['tenant'] } }, async (request, reply) => {
    const identity = await admin(request, pools);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    let closed = false;
    const emit = async () => {
      if (closed) return;
      try {
        const data = await withTenant(pools, identity, async client => (await client.query(`SELECT s.courier_membership_id AS sharing_id,u.full_name,
            last.latitude,last.longitude,last.received_at,s.started_at,s.last_seen_at,
            CASE WHEN last.received_at IS NULL THEN 'no_signal'
              WHEN last.received_at < now()-interval '90 seconds' THEN 'stale' ELSE 'ok' END AS gps_status
          FROM app.courier_location_sharing s
          JOIN app.tenant_memberships m ON m.id=s.courier_membership_id
          JOIN app.users u ON u.id=m.user_id
          LEFT JOIN LATERAL (SELECT latitude,longitude,received_at FROM app.courier_locations l
            WHERE l.courier_membership_id=s.courier_membership_id AND l.captured_at>=s.started_at AND l.accuracy_m<=$1 ORDER BY l.captured_at DESC LIMIT 1) last ON true
          WHERE s.status='active' ORDER BY u.full_name`, [config.gpsLowPrecisionThresholdM])).rows);
        raw.write(`event: locations\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { if (!closed) raw.write('event: error\ndata: {"message":"Não foi possível atualizar as localizações"}\n\n'); }
    };
    await emit();
    const timer = setInterval(() => { void emit(); }, 5000);
    const close = () => { if (closed) return; closed = true; clearInterval(timer); };
    request.raw.on('close', close);
    request.raw.on('aborted', close);
  });
}
