import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../config.js';
import type { DbPools } from '../db.js';
import { withTenant } from '../db.js';
import { authenticate } from '../auth.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { preparePhoto, readPhoto, removePhoto, savePhoto } from '../storage.js';
import { sha256 } from '../security.js';
import { lockOperation } from './deliveries.js';

const uuid = { type: 'string', format: 'uuid' };

export function registerMobileRoutes(app: FastifyInstance, pools: DbPools, config: ApiConfig): void {
  app.post('/v1/mobile/routes', { schema:{tags:['mobile'],body:{type:'object',required:['deliveryIds'],properties:{deliveryIds:{type:'array',minItems:1,maxItems:50,items:uuid}},additionalProperties:false}}}, async request=>{
    const {identity}=await authenticate(request,pools);if(identity.role!=='courier'||identity.scope!=='tenant')forbidden();
    const {deliveryIds}=request.body as {deliveryIds:string[]};if(new Set(deliveryIds).size!==deliveryIds.length)badRequest('Entregas repetidas na rota');
    return withTenant(pools,identity,async client=>{
      const active=await client.query("SELECT id FROM app.delivery_routes WHERE courier_membership_id=$1 AND status='active'",[identity.membershipId]);if(active.rowCount)conflict('Já existe uma rota ativa');
      const rows=await client.query("SELECT id FROM app.deliveries WHERE id=ANY($1::uuid[]) AND courier_membership_id=$2 AND status IN ('assigned','in_progress')",[deliveryIds,identity.membershipId]);if(rows.rowCount!==deliveryIds.length)conflict('Todas as paradas devem estar atribuídas a você e abertas');
      const route=await client.query("INSERT INTO app.delivery_routes(tenant_id,courier_membership_id,status) VALUES(app.current_tenant_id(),$1,'draft') RETURNING id",[identity.membershipId]);
      for(const [position,id] of deliveryIds.entries())await client.query("INSERT INTO app.delivery_route_stops(tenant_id,route_id,delivery_id,position) VALUES(app.current_tenant_id(),$1,$2,$3)",[route.rows[0]!.id,id,position]);return {id:route.rows[0]!.id,deliveryIds};
    });
  });
  app.post('/v1/mobile/routes/:id/start',{schema:{tags:['mobile'],params:{type:'object',required:['id'],properties:{id:uuid}}}},async request=>{
    const {identity}=await authenticate(request,pools);if(identity.role!=='courier'||identity.scope!=='tenant')forbidden();const {id}=request.params as {id:string};
    return withTenant(pools,identity,async client=>{const result=await client.query("UPDATE app.delivery_routes SET status='active',started_at=now() WHERE id=$1 AND courier_membership_id=$2 AND status='draft' RETURNING id",[id,identity.membershipId]);if(!result.rowCount)conflict('Rota indisponível');await client.query("UPDATE app.delivery_route_stops SET status='active' WHERE tenant_id=app.current_tenant_id() AND route_id=$1 AND position=(SELECT min(position) FROM app.delivery_route_stops WHERE tenant_id=app.current_tenant_id() AND route_id=$1)",[id]);return {id,started:true};});
  });
  app.get('/v1/mobile/routes/:id',{schema:{tags:['mobile'],params:{type:'object',required:['id'],properties:{id:uuid}}}},async request=>{
    const {identity}=await authenticate(request,pools);if(identity.role!=='courier'||identity.scope!=='tenant')forbidden();const {id}=request.params as {id:string};
    return withTenant(pools,identity,async client=>{const result=await client.query('SELECT id,status FROM app.delivery_routes WHERE id=$1 AND courier_membership_id=$2',[id,identity.membershipId]);return result.rows[0]??notFound();});
  });
  app.post('/v1/mobile/routes/:id/locations',{schema:{tags:['mobile'],params:{type:'object',required:['id'],properties:{id:uuid}},body:{type:'object',required:['points'],properties:{points:{type:'array',minItems:1,maxItems:100,items:{type:'object',required:['clientPointId','latitude','longitude','accuracyM','capturedAt'],properties:{clientPointId:uuid,latitude:{type:'number',minimum:-90,maximum:90},longitude:{type:'number',minimum:-180,maximum:180},accuracyM:{type:'number',minimum:0},capturedAt:{type:'string',format:'date-time'}},additionalProperties:false}}},additionalProperties:false}}},async request=>{
    const {identity}=await authenticate(request,pools);if(identity.role!=='courier'||identity.scope!=='tenant')forbidden();const {id}=request.params as {id:string};const {points}=request.body as {points:Array<{clientPointId:string;latitude:number;longitude:number;accuracyM:number;capturedAt:string}>};
    return withTenant(pools,identity,async client=>{const route=await client.query("SELECT id FROM app.delivery_routes WHERE id=$1 AND courier_membership_id=$2 AND status='active'",[id,identity.membershipId]);if(!route.rowCount)notFound();let accepted=0;for(const p of points){const r=await client.query('INSERT INTO app.delivery_route_locations(tenant_id,route_id,client_point_id,courier_membership_id,latitude,longitude,accuracy_m,captured_at) VALUES(app.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,client_point_id) DO NOTHING',[id,p.clientPointId,identity.membershipId,p.latitude,p.longitude,p.accuracyM,p.capturedAt]);accepted+=r.rowCount??0;}return {accepted};});
  });
  app.get('/v1/tenant/routes/:id/live', { schema: { tags:['tenant'], params:{type:'object',required:['id'],properties:{id:uuid}} } }, async request => {
    const {identity}=await authenticate(request,pools); if(identity.role!=='admin'||identity.scope!=='tenant') forbidden();
    const {id}=request.params as {id:string};
    return withTenant(pools,identity,async client=>{
      const route=await client.query('SELECT id,status,courier_membership_id,started_at FROM app.delivery_routes WHERE id=$1',[id]);
      if(!route.rowCount) notFound();
      const stops=await client.query('SELECT s.delivery_id,s.position,s.status,d.customer_id,d.destination_snapshot FROM app.delivery_route_stops s JOIN app.deliveries d ON d.id=s.delivery_id AND d.tenant_id=s.tenant_id WHERE s.route_id=$1 ORDER BY s.position',[id]);
      const points=await client.query("SELECT latitude,longitude,accuracy_m,captured_at,received_at FROM app.delivery_route_locations WHERE route_id=$1 AND captured_at>now()-interval '30 days' ORDER BY captured_at",[id]);
      return {route:route.rows[0],stops:stops.rows,points:points.rows};
    });
  });
  app.get('/v1/mobile/available', { schema: { tags:['mobile'] } }, async request => {
    const {identity}=await authenticate(request,pools); if(identity.role!=='courier'||identity.scope!=='tenant') forbidden();
    return withTenant(pools,identity,async client=>{
      const result=await client.query(`SELECT d.id,d.merchandise_description,d.destination_snapshot,d.scheduled_for,d.created_at,c.name AS customer_name,
        coalesce((SELECT jsonb_agg(jsonb_build_object('id',di.id,'catalog_item_id',di.catalog_item_id,'name',di.item_name,'icon_key',di.icon_key,'quantity',di.quantity) ORDER BY di.id) FROM app.delivery_items di WHERE di.tenant_id=d.tenant_id AND di.delivery_id=d.id),'[]'::jsonb) AS items
        FROM app.deliveries d JOIN app.customers c ON c.id=d.customer_id AND c.tenant_id=d.tenant_id
        WHERE d.is_claimable AND d.status='pending' AND d.courier_membership_id IS NULL ORDER BY d.created_at LIMIT 100`);
      return {items:result.rows};
    });
  });

  app.get('/v1/mobile/profile', { schema: { tags: ['mobile'] } }, async request => {
    const { identity } = await authenticate(request,pools);
    if (identity.role !== 'courier' || identity.scope !== 'tenant') forbidden();
    return withTenant(pools,identity,async client => {
      const result = await client.query('SELECT full_name,profile_location,profile_photo_key IS NOT NULL AS has_photo,profile_cover_key IS NOT NULL AS has_cover FROM app.users WHERE id=app.current_user_id()');
      return result.rows[0] ?? notFound();
    });
  });

  app.patch('/v1/mobile/profile', { schema: { tags: ['mobile'], body: { type: 'object', minProperties: 1,
    properties: { fullName: { type: 'string', minLength: 1, maxLength: 160 }, location: { type: ['string','null'], maxLength: 200 } }, additionalProperties: false } } }, async request => {
    const { identity } = await authenticate(request,pools);
    if (identity.role !== 'courier' || identity.scope !== 'tenant') forbidden();
    const body = request.body as { fullName?: string; location?: string | null };
    if (body.fullName !== undefined && !body.fullName.trim()) badRequest('Nome inválido');
    if (body.location !== undefined && body.location !== null && !body.location.trim()) badRequest('Local de atuação inválido');
    return withTenant(pools,identity,async client => {
      await client.query('UPDATE app.users SET full_name=coalesce($1,full_name),profile_location=CASE WHEN $2::boolean THEN $3 ELSE profile_location END,updated_at=now() WHERE id=app.current_user_id()',
        [body.fullName?.trim() ?? null,body.location !== undefined,body.location?.trim() || null]);
      const result = await client.query('SELECT full_name,profile_location,profile_photo_key IS NOT NULL AS has_photo,profile_cover_key IS NOT NULL AS has_cover FROM app.users WHERE id=app.current_user_id()');
      return result.rows[0] ?? notFound();
    });
  });

  app.put('/v1/mobile/profile/photo', { schema: { tags: ['mobile'] } }, async request => {
    const { identity } = await authenticate(request,pools);
    if (identity.role !== 'courier' || identity.scope !== 'tenant') forbidden();
    let photo: Buffer | null = null;
    let declaredMime = '';
    for await (const part of request.parts()) {
      if (part.type !== 'file' || part.fieldname !== 'photo' || photo) badRequest('Envie uma foto no campo photo');
      declaredMime = part.mimetype; photo = await part.toBuffer();
    }
    if (!photo) badRequest('Foto obrigatória');
    const prepared = await preparePhoto(photo,declaredMime);
    let savedKey: string | null = null; let oldKey: string | null = null;
    try {
      const result = await withTenant(pools,identity,async client => {
        const previous = await client.query<{ old_key: string | null; tenant_id: string }>(`SELECT u.profile_photo_key AS old_key,app.current_tenant_id() AS tenant_id
          FROM app.users u WHERE u.id=app.current_user_id()`);
        if (!previous.rows[0]) notFound();
        const stored = await savePhoto(config,previous.rows[0]!.tenant_id!,identity.membershipId!,prepared.bytes);
        savedKey = stored.key; oldKey = previous.rows[0].old_key;
        await client.query('UPDATE app.users SET profile_photo_key=$1,updated_at=now() WHERE id=app.current_user_id()',[stored.key]);
        const profile = await client.query<{ full_name: string; profile_location: string | null; has_cover: boolean }>(
          'SELECT full_name,profile_location,profile_cover_key IS NOT NULL AS has_cover FROM app.users WHERE id=app.current_user_id()');
        return { ...profile.rows[0]!, has_photo: true };
      });
      if (oldKey) await removePhoto(config,oldKey);
      return result;
    } catch (error) { if (savedKey) await removePhoto(config,savedKey); throw error; }
  });

  app.get('/v1/mobile/profile/photo', { schema: { tags: ['mobile'] } }, async (request,reply) => {
    const { identity } = await authenticate(request,pools);
    if (identity.role !== 'courier' || identity.scope !== 'tenant') forbidden();
    const key = await withTenant(pools,identity,async client => {
      const result = await client.query<{ profile_photo_key: string | null }>('SELECT profile_photo_key FROM app.users WHERE id=app.current_user_id()');
      return result.rows[0]?.profile_photo_key ?? notFound();
    });
    reply.type('image/jpeg').header('Cache-Control','private, no-store');
    return reply.send(readPhoto(config,key));
  });

  app.put('/v1/mobile/profile/cover', { schema: { tags: ['mobile'] } }, async request => {
    const { identity } = await authenticate(request,pools);
    if (identity.role !== 'courier' || identity.scope !== 'tenant') forbidden();
    let photo: Buffer | null = null;
    let declaredMime = '';
    for await (const part of request.parts()) {
      if (part.type !== 'file' || part.fieldname !== 'photo' || photo) badRequest('Envie uma imagem no campo photo');
      declaredMime = part.mimetype; photo = await part.toBuffer();
    }
    if (!photo) badRequest('Imagem de capa obrigatória');
    const prepared = await preparePhoto(photo,declaredMime);
    let savedKey: string | null = null; let oldKey: string | null = null;
    try {
      const profile = await withTenant(pools,identity,async client => {
        const previous = await client.query<{ old_key: string | null; tenant_id: string }>(`SELECT u.profile_cover_key AS old_key,app.current_tenant_id() AS tenant_id
          FROM app.users u WHERE u.id=app.current_user_id()`);
        if (!previous.rows[0]) notFound();
        const stored = await savePhoto(config,previous.rows[0]!.tenant_id!,identity.membershipId!,prepared.bytes);
        savedKey = stored.key; oldKey = previous.rows[0].old_key;
        await client.query('UPDATE app.users SET profile_cover_key=$1,updated_at=now() WHERE id=app.current_user_id()',[stored.key]);
        const result = await client.query<{ full_name: string; profile_location: string | null; has_photo: boolean }>(
          'SELECT full_name,profile_location,profile_photo_key IS NOT NULL AS has_photo FROM app.users WHERE id=app.current_user_id()');
        return { ...result.rows[0]!, has_cover: true };
      });
      if (oldKey) await removePhoto(config,oldKey);
      return profile;
    } catch (error) { if (savedKey) await removePhoto(config,savedKey); throw error; }
  });

  app.get('/v1/mobile/profile/cover', { schema: { tags: ['mobile'] } }, async (request,reply) => {
    const { identity } = await authenticate(request,pools);
    if (identity.role !== 'courier' || identity.scope !== 'tenant') forbidden();
    const key = await withTenant(pools,identity,async client => {
      const result = await client.query<{ profile_cover_key: string | null }>('SELECT profile_cover_key FROM app.users WHERE id=app.current_user_id()');
      return result.rows[0]?.profile_cover_key ?? notFound();
    });
    reply.type('image/jpeg').header('Cache-Control','private, no-store');
    return reply.send(readPhoto(config,key));
  });

  app.get('/v1/mobile/productivity', { schema: { tags: ['mobile'], querystring: { type: 'object', properties: { period: { enum: ['day','week','month'] } } } } }, async request => {
    const { identity } = await authenticate(request,pools);
    if (identity.role !== 'courier' || identity.scope !== 'tenant') forbidden();
    const { period = 'day' } = request.query as { period?: 'day'|'week'|'month' };
    return withTenant(pools,identity,async client => {
      const summary = await client.query<{ day: string; week: string; month: string }>(`WITH clock AS (
        SELECT (now() AT TIME ZONE 'America/Fortaleza')::date AS today,date_trunc('week',now() AT TIME ZONE 'America/Fortaleza')::date AS week_start,
          date_trunc('month',now() AT TIME ZONE 'America/Fortaleza')::date AS month_start
      ) SELECT count(*) FILTER (WHERE d.completed_at >= c.today::timestamp AT TIME ZONE 'America/Fortaleza' AND d.completed_at < (c.today+1)::timestamp AT TIME ZONE 'America/Fortaleza')::text AS day,
        count(*) FILTER (WHERE d.completed_at >= c.week_start::timestamp AT TIME ZONE 'America/Fortaleza' AND d.completed_at < (c.today+1)::timestamp AT TIME ZONE 'America/Fortaleza')::text AS week,
        count(*) FILTER (WHERE d.completed_at >= c.month_start::timestamp AT TIME ZONE 'America/Fortaleza' AND d.completed_at < (c.today+1)::timestamp AT TIME ZONE 'America/Fortaleza')::text AS month
        FROM app.deliveries d CROSS JOIN clock c WHERE d.courier_membership_id=app.current_membership_id() AND d.status='completed'`);
      const lifetime = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM app.deliveries
        WHERE courier_membership_id=app.current_membership_id() AND status='completed'`);
      const weekComparison = await client.query<{ current_count:string; previous_count:string; is_monday:boolean }>(`WITH local AS (
        SELECT date_trunc('week',now() AT TIME ZONE 'America/Fortaleza')::date AS current_start,
          (date_trunc('week',now() AT TIME ZONE 'America/Fortaleza')-interval '7 days')::date AS previous_start,
          extract(isodow from now() AT TIME ZONE 'America/Fortaleza')=1 AS is_monday
      ) SELECT bool_or(l.is_monday) AS is_monday,count(*) FILTER (WHERE d.completed_at >= l.current_start::timestamp AT TIME ZONE 'America/Fortaleza')::text AS current_count,
        count(*) FILTER (WHERE d.completed_at >= l.previous_start::timestamp AT TIME ZONE 'America/Fortaleza' AND d.completed_at < l.current_start::timestamp AT TIME ZONE 'America/Fortaleza')::text AS previous_count
        FROM app.deliveries d CROSS JOIN local l WHERE d.courier_membership_id=app.current_membership_id() AND d.status='completed'`);
      const metrics = await client.query<{ average_minutes:string|null; on_time_percent:string|null; distance_km:string|null; earnings_cents:string|null }>(`WITH completed AS (
        SELECT d.id,d.scheduled_for,d.completed_at,d.estimated_earnings_cents,checkin.occurred_at AS checked_in_at
        FROM app.deliveries d LEFT JOIN LATERAL (
          SELECT occurred_at FROM app.delivery_events e WHERE e.delivery_id=d.id AND e.kind='check_in' ORDER BY occurred_at LIMIT 1
        ) checkin ON true
        WHERE d.courier_membership_id=app.current_membership_id() AND d.status='completed'
      ), points AS (
        SELECT l.route_id,l.latitude,l.longitude,LAG(l.latitude) OVER (PARTITION BY l.route_id ORDER BY l.captured_at) AS previous_latitude,
          LAG(l.longitude) OVER (PARTITION BY l.route_id ORDER BY l.captured_at) AS previous_longitude
        FROM app.delivery_route_locations l WHERE l.courier_membership_id=app.current_membership_id()
      ), distance AS (
        SELECT coalesce(sum(2*6371*asin(sqrt(power(sin(radians(latitude-previous_latitude)/2),2)+cos(radians(previous_latitude))*cos(radians(latitude))*power(sin(radians(longitude-previous_longitude)/2),2)))),0)::text AS distance_km
        FROM points WHERE previous_latitude IS NOT NULL
      ) SELECT (SELECT avg(extract(epoch FROM (completed_at-checked_in_at))/60)::text FROM completed WHERE checked_in_at IS NOT NULL) AS average_minutes,
        (SELECT coalesce(100*avg(CASE WHEN scheduled_for IS NULL OR completed_at <= scheduled_for THEN 1 ELSE 0 END),0)::text FROM completed) AS on_time_percent,
        (SELECT distance_km FROM distance),
        (SELECT coalesce(sum(estimated_earnings_cents),0)::text FROM completed) AS earnings_cents`);
      const streak = await client.query<{ days: string }>(`WITH calendar AS (
        SELECT generate_series(0,60) AS offset
      ), missing AS (
        SELECT min(c.offset) AS first_missing FROM calendar c
        WHERE NOT EXISTS (
          SELECT 1 FROM app.deliveries d
          WHERE d.courier_membership_id=app.current_membership_id() AND d.status='completed'
            AND (d.completed_at AT TIME ZONE 'America/Fortaleza')::date =
              ((now() AT TIME ZONE 'America/Fortaleza')::date - c.offset)
        )
      ) SELECT coalesce(first_missing,61)::text AS days FROM missing`);
      const gamification = await client.query<{ daily_goal: number; celebration_enabled: boolean }>(
        `SELECT daily_goal,celebration_enabled FROM app.gamification_settings WHERE tenant_id=app.current_tenant_id()`);
      await client.query(`INSERT INTO app.problem_reasons(tenant_id,code,label,sort_order)
        SELECT app.current_tenant_id(),v.code,v.label,v.sort_order FROM (VALUES
          ('customer_absent','Cliente ausente',1),('address_not_found','Endereço não encontrado',2),
          ('customer_refused','Cliente recusou',3),('other','Outro',4)
        ) AS v(code,label,sort_order) ON CONFLICT (tenant_id,code) DO NOTHING`);
      const configuredBadges = await client.query<{ id:string; name:string; description:string; target:number; progress:number; unlocked_at:string|null }>(
        `WITH progress AS (
          SELECT b.id,b.name,b.description,b.target,
            LEAST(b.target,COUNT(d.id)::int) AS progress,
            COUNT(d.id) >= b.target AS unlocked
          FROM app.gamification_badges b
          LEFT JOIN app.deliveries d ON d.tenant_id=b.tenant_id
            AND d.courier_membership_id=app.current_membership_id()
            AND d.status='completed'
          WHERE b.tenant_id=app.current_tenant_id() AND b.active
          GROUP BY b.id,b.name,b.description,b.target
        ), upserted AS (
          INSERT INTO app.courier_badges(tenant_id,badge_id,membership_id,progress,unlocked_at)
          SELECT app.current_tenant_id(),id,app.current_membership_id(),progress,
            CASE WHEN unlocked THEN now() ELSE NULL END
          FROM progress
          ON CONFLICT (tenant_id,badge_id,membership_id) DO UPDATE SET
            progress=EXCLUDED.progress,
            unlocked_at=coalesce(app.courier_badges.unlocked_at,EXCLUDED.unlocked_at),
            updated_at=now()
          RETURNING badge_id,progress,unlocked_at
        )
        SELECT p.id,p.name,p.description,p.target,u.progress,u.unlocked_at
        FROM progress p JOIN upserted u ON u.badge_id=p.id ORDER BY p.target,p.name`);
      const challenge = await client.query<{ id:string; name:string; description:string; target:number; starts_at:string; ends_at:string; bonus_cents:number }>(
        `SELECT id,name,description,target,starts_at,ends_at,bonus_cents FROM app.gamification_challenges
         WHERE tenant_id=app.current_tenant_id() AND active AND starts_at <= (now() AT TIME ZONE 'America/Fortaleza')::date
           AND ends_at >= (now() AT TIME ZONE 'America/Fortaleza')::date ORDER BY ends_at,created_at LIMIT 1`);
      const problemReasons = await client.query<{ code:string; label:string }>(
        `SELECT code,label FROM app.problem_reasons
         WHERE tenant_id=app.current_tenant_id() AND active ORDER BY sort_order,label`);
      const seasons=await client.query<{week_start:Date;week_end:Date;week_start_date:string;month_start:Date;month_end:Date;month_start_date:string}>(`WITH local AS (
        SELECT now() AT TIME ZONE 'America/Fortaleza' AS local_now
      ), periods AS (
        SELECT date_trunc('week',local_now) AS week_date,date_trunc('month',local_now) AS month_date FROM local
      ) SELECT week_date::date::text AS week_start_date,
        week_date AT TIME ZONE 'America/Fortaleza' AS week_start,
        (week_date+interval '7 days') AT TIME ZONE 'America/Fortaleza' AS week_end,
        month_date::date::text AS month_start_date,
        month_date AT TIME ZONE 'America/Fortaleza' AS month_start,
        (month_date+interval '1 month') AT TIME ZONE 'America/Fortaleza' AS month_end FROM periods`);
      const season=seasons.rows[0]!;
      const weekStanding=await client.query<{completed_count:string;standing:string|null;total_couriers:number}>(`SELECT result.completed_count,result.standing,result.total_couriers FROM app.courier_period_standing($1,$2) AS result`,[season.week_start,season.week_end]);
      const monthStanding=await client.query<{completed_count:string;standing:string|null;total_couriers:number}>(`SELECT result.completed_count,result.standing,result.total_couriers FROM app.courier_period_standing($1,$2) AS result`,[season.month_start,season.month_end]);
      const leaderboard=await client.query<{membership_id:string;full_name:string;profile_photo_key:string|null;week_completed:string;month_completed:string;week_rank:string|null;month_rank:string|null;week_winner:boolean;month_winner:boolean}>(`SELECT * FROM app.courier_seasonal_leaderboard($1,$2,$3,$4)`,
        [season.week_start,season.week_end,season.month_start,season.month_end]);
      const seasonalAward=(windowStart:string,resetAt:Date,row:{completed_count:string;standing:string|null;total_couriers:number}|undefined)=>{
        const completed=Number(row?.completed_count??0),rank=row?.standing===null||row?.standing===undefined?null:Number(row.standing);
        return {periodStart:windowStart,resetAt:resetAt.toISOString(),completed,rank,totalCouriers:Number(row?.total_couriers??0),awarded:completed>0&&rank===1};
      };
      const series = await client.query<{ label: string; count: number }>(`WITH clock AS (
        SELECT (now() AT TIME ZONE 'America/Fortaleza')::date AS today,date_trunc('week',now() AT TIME ZONE 'America/Fortaleza')::date AS week_start,
          date_trunc('month',now() AT TIME ZONE 'America/Fortaleza')::date AS month_start,
          extract(day FROM (date_trunc('month',now() AT TIME ZONE 'America/Fortaleza')+interval '1 month - 1 day'))::int AS month_days
      ), buckets AS (
        SELECT (c.today::timestamp+make_interval(hours=>h.value)) AS starts_at FROM clock c CROSS JOIN generate_series(0,23) h(value) WHERE $1='day'
        UNION ALL SELECT (c.week_start+d.value)::timestamp FROM clock c CROSS JOIN generate_series(0,6) d(value) WHERE $1='week'
        UNION ALL SELECT (c.month_start+d.value)::timestamp FROM clock c CROSS JOIN generate_series(0,c.month_days-1) d(value) WHERE $1='month'
      ) SELECT CASE WHEN $1='day' THEN to_char(b.starts_at,'HH24')||'h' WHEN $1='week' THEN to_char(b.starts_at,'DD/MM') ELSE to_char(b.starts_at,'DD') END AS label,
        count(d.id)::int AS count FROM buckets b LEFT JOIN app.deliveries d ON d.courier_membership_id=app.current_membership_id() AND d.status='completed'
        AND d.completed_at >= b.starts_at AT TIME ZONE 'America/Fortaleza' AND d.completed_at < (b.starts_at+CASE WHEN $1='day' THEN interval '1 hour' ELSE interval '1 day' END) AT TIME ZONE 'America/Fortaleza'
        GROUP BY b.starts_at ORDER BY b.starts_at`,[period]);
      return { summary: Object.fromEntries(Object.entries(summary.rows[0]!).map(([key,value]) => [key,Number(value)])),
        lifetime: Number(lifetime.rows[0]!.count), period, items: series.rows,
        seasonalAwards:{week:seasonalAward(season.week_start_date,season.week_end,weekStanding.rows[0]),
          month:seasonalAward(season.month_start_date,season.month_end,monthStanding.rows[0])},
        dailyGoal:Number(gamification.rows[0]?.daily_goal??10),celebrationEnabled:gamification.rows[0]?.celebration_enabled??true,streakDays:Number(streak.rows[0]?.days??0),
        metrics:{averageMinutes:metrics.rows[0]?.average_minutes?Number(metrics.rows[0].average_minutes):null,onTimePercent:Number(metrics.rows[0]?.on_time_percent??0),distanceKm:Number(metrics.rows[0]?.distance_km??0),estimatedEarningsCents:Number(metrics.rows[0]?.earnings_cents??0)},
        weekComparison:{current:Number(weekComparison.rows[0]?.current_count??0),previous:Number(weekComparison.rows[0]?.previous_count??0)},
        weeklySummary:weekComparison.rows[0]?.is_monday?{current:Number(weekComparison.rows[0]?.current_count??0),previous:Number(weekComparison.rows[0]?.previous_count??0)}:null,
        problemReasons:problemReasons.rows.map(reason=>({code:reason.code,label:reason.label})),
        badges:configuredBadges.rows.map(row=>({id:row.id,title:row.name,hint:row.description,target:Number(row.target),progress:Number(row.progress),unlockedAt:row.unlocked_at})),
        challenge:challenge.rows[0]?{id:challenge.rows[0].id,title:challenge.rows[0].name,description:challenge.rows[0].description,target:Number(challenge.rows[0].target),startsAt:challenge.rows[0].starts_at,endsAt:challenge.rows[0].ends_at,bonusCents:Number(challenge.rows[0].bonus_cents)}:null,
        leaderboard:leaderboard.rows.map(row=>({membershipId:row.membership_id,name:row.full_name,hasPhoto:!!row.profile_photo_key,
          weekCompleted:Number(row.week_completed),monthCompleted:Number(row.month_completed),weekRank:row.week_rank?Number(row.week_rank):null,
          monthRank:row.month_rank?Number(row.month_rank):null,weekWinner:row.week_winner,monthWinner:row.month_winner})),
        currentMembershipId:identity.membershipId };
    });
  });

  app.get('/v1/mobile/leaderboard/:membershipId/photo', { schema:{tags:['mobile'],params:{type:'object',required:['membershipId'],properties:{membershipId:uuid}}} }, async (request,reply)=>{
    const {identity}=await authenticate(request,pools);
    if(identity.role!=='courier'||identity.scope!=='tenant') forbidden();
    const {membershipId}=request.params as {membershipId:string};
    const key=await withTenant(pools,identity,async client=>{
      const result=await client.query<{photo_key:string|null}>('SELECT app.courier_profile_photo($1) AS photo_key',[membershipId]);
      return result.rows[0]?.photo_key??null;
    });
    if(!key) notFound();
    reply.type('image/jpeg').header('Cache-Control','private, max-age=300');
    return reply.send(readPhoto(config,key));
  });

  app.put('/v1/mobile/devices/:installationId', { schema: { tags: ['mobile'], params: { type: 'object', required: ['installationId'],
    properties: { installationId: { type: 'string', minLength: 1, maxLength: 200 } } },
    body: { type: 'object', properties: { fcmToken: { type: 'string', minLength: 1 } }, additionalProperties: false } } }, async request => {
    const { identity } = await authenticate(request,pools);
    if (identity.role !== 'courier') forbidden();
    const { installationId } = request.params as { installationId: string };
    const { fcmToken } = (request.body ?? {}) as { fcmToken?: string };
    return withTenant(pools,identity,async client => {
      const result = await client.query(`INSERT INTO app.devices(tenant_id,membership_id,installation_id,fcm_token,last_seen_at)
        VALUES (app.current_tenant_id(),$1,$2,$3,now())
        ON CONFLICT (tenant_id,installation_id) DO UPDATE SET membership_id=EXCLUDED.membership_id,
          fcm_token=EXCLUDED.fcm_token,revoked_at=NULL,last_seen_at=now() RETURNING id`,
        [identity.membershipId,installationId,fcmToken ?? null]);
      return { id: result.rows[0].id };
    });
  });

  app.delete('/v1/mobile/devices/:installationId', { schema: { tags: ['mobile'], params: { type: 'object', required: ['installationId'],
    properties: { installationId: { type: 'string' } } } } }, async request => {
    const { identity } = await authenticate(request,pools);
    if (identity.role !== 'courier') forbidden();
    const { installationId } = request.params as { installationId: string };
    return withTenant(pools,identity,async client => {
      await client.query(`UPDATE app.devices SET revoked_at=now(),fcm_token=NULL
        WHERE installation_id=$1 AND membership_id=$2`, [installationId,identity.membershipId]);
      return { ok: true };
    });
  });

  app.get('/v1/mobile/sync', { schema: { tags: ['mobile'], querystring: { type: 'object', properties: {
    since: { type: 'string', format: 'date-time' }, until: { type: 'string', format: 'date-time' },
    cursor: uuid, removalCursor: uuid,
    limit: { type: 'integer', minimum: 1, maximum: 100 } } } } }, async request => {
    const { identity } = await authenticate(request,pools);
    if (identity.role !== 'courier') forbidden();
    const { since,until,cursor,removalCursor,limit } = request.query as {
      since?: string; until?: string; cursor?: string; removalCursor?: string; limit?: number };
    return withTenant(pools,identity,async client => {
      const cutoff = await client.query<{ cutoff: Date }>('SELECT coalesce($1::timestamptz,now()) AS cutoff',[until ?? null]);
      const serverTime = cutoff.rows[0]!.cutoff;
      const deliveries = await client.query(`SELECT d.id,d.status,d.customer_id,d.address_id,d.merchandise_description,
        d.destination_snapshot,d.instructions,d.scheduled_for,d.created_at,d.updated_at,d.viewed_at,d.completed_at,d.cancelled_at,
        coalesce((SELECT jsonb_agg(jsonb_build_object('id',di.id,'catalog_item_id',di.catalog_item_id,'name',di.item_name,'icon_key',di.icon_key,'quantity',di.quantity) ORDER BY di.id) FROM app.delivery_items di WHERE di.tenant_id=d.tenant_id AND di.delivery_id=d.id),'[]'::jsonb) AS items,
        CASE WHEN d.destination_snapshot->>'street'=a.street
          AND coalesce(d.destination_snapshot->>'number','')=coalesce(a.number,'')
          AND coalesce(d.destination_snapshot->>'city','')=a.city
          AND coalesce(d.destination_snapshot->>'state','')=a.state THEN a.reference_latitude END AS reference_latitude,
        CASE WHEN d.destination_snapshot->>'street'=a.street
          AND coalesce(d.destination_snapshot->>'number','')=coalesce(a.number,'')
          AND coalesce(d.destination_snapshot->>'city','')=a.city
          AND coalesce(d.destination_snapshot->>'state','')=a.state THEN a.reference_longitude END AS reference_longitude,
        check_in.latitude AS last_check_in_latitude,check_in.longitude AS last_check_in_longitude,
        c.name AS customer_name,c.phone AS customer_phone
        FROM app.deliveries d JOIN app.customers c ON c.id=d.customer_id AND c.tenant_id=d.tenant_id
        JOIN app.addresses a ON a.id=d.address_id AND a.tenant_id=d.tenant_id
        LEFT JOIN LATERAL (
          SELECT e.latitude,e.longitude FROM app.delivery_events e
          WHERE e.tenant_id=d.tenant_id AND e.delivery_id=d.id AND e.kind='check_in'
            AND e.actor_membership_id=$6 AND e.occurred_at>=d.assigned_at
          ORDER BY e.occurred_at DESC,e.recorded_at DESC LIMIT 1
        ) check_in ON true
        WHERE d.courier_membership_id=$1 AND ($2::timestamptz IS NULL OR d.updated_at>=$2)
          AND d.updated_at<=$5::timestamptz
          AND ($3::uuid IS NULL OR d.id<$3)
        ORDER BY d.id DESC LIMIT $4`, [identity.membershipId,since ?? null,cursor ?? null,limit ?? 50,serverTime,identity.membershipId]);
      const removals = await client.query<{ id: string; delivery_id: string }>(`SELECT id,delivery_id
        FROM app.delivery_assignment_removals WHERE membership_id=$1
          AND ($2::timestamptz IS NULL OR changed_at>=$2) AND ($3::uuid IS NULL OR id<$3)
          AND changed_at<=$5::timestamptz
        ORDER BY id DESC LIMIT $4`,[identity.membershipId,since ?? null,removalCursor ?? null,limit ?? 50,serverTime]);
      return { items: deliveries.rows, nextCursor: deliveries.rows.at(-1)?.id ?? null,
        removedDeliveryIds: removals.rows.map(row => row.delivery_id),
        removalsNextCursor: removals.rows.at(-1)?.id ?? null,
        serverTime: serverTime.toISOString() };
    });
  });

  app.post('/v1/deliveries/:id/completion', { schema: { tags: ['mobile'], params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async request => {
    const { identity } = await authenticate(request,pools);
    if (identity.role !== 'courier') forbidden();
    const { id } = request.params as { id: string };
    const fields: Record<string,string> = {};
    let photo: Buffer | null = null;
    let declaredMime = '';
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'photo' || photo) badRequest('Uma foto é obrigatória');
        declaredMime = part.mimetype;
        photo = await part.toBuffer();
      } else fields[part.fieldname] = String(part.value);
    }
    if (!photo || !fields.clientOperationId || !fields.occurredAt ||
      !/^[0-9a-f-]{36}$/i.test(fields.clientOperationId) || Number.isNaN(Date.parse(fields.occurredAt))) badRequest('Dados da conclusão inválidos');
    const prepared = await preparePhoto(photo,declaredMime);
    const requestHash = sha256(JSON.stringify({ id, kind: 'completed', operation: fields.clientOperationId,
      occurredAt: fields.occurredAt, note: fields.note ?? '', photoHash: prepared.sourceHash }));
    const pendingFiles: string[] = [];
    try {
      return await withTenant(pools,identity,async client => {
        await lockOperation(client,fields.clientOperationId!);
        const previous = await client.query<{ id: string; delivery_id: string; metadata: { request_hash?: string } }>(
          'SELECT id,delivery_id,metadata FROM app.delivery_events WHERE client_operation_id=$1', [fields.clientOperationId]);
        if (previous.rows[0]) {
          if (previous.rows[0].metadata.request_hash !== requestHash || previous.rows[0].delivery_id !== id)
            conflict('Chave de operação reutilizada com conteúdo diferente');
          return { eventId: previous.rows[0].id, replayed: true };
        }
        const delivery = await client.query<{ status: string; courier_membership_id: string; assigned_at: Date }>(
          'SELECT status,courier_membership_id,assigned_at FROM app.deliveries WHERE id=$1 FOR UPDATE', [id]);
        const current = delivery.rows[0];
        if (!current || current.courier_membership_id !== identity.membershipId) notFound();
        if (!['in_progress','problem'].includes(current.status)) conflict('Check-in necessário antes da conclusão');
        const checkIn = await client.query(`SELECT 1 FROM app.delivery_events WHERE delivery_id=$1
          AND actor_membership_id=$2 AND kind='check_in' AND recorded_at>=coalesce($3::timestamptz,'-infinity'::timestamptz)
          LIMIT 1`, [id,identity.membershipId,current.assigned_at]);
        if (!checkIn.rowCount) conflict('Check-in necessário antes da conclusão');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text,0))');
        const quota = await client.query<{ max_storage_bytes: string | null; used_storage_bytes: string }>(
          'SELECT max_storage_bytes,used_storage_bytes FROM app.active_plan_limits()');
        if (!quota.rows[0]) forbidden();
        if (quota.rows[0].max_storage_bytes !== null &&
          BigInt(quota.rows[0].used_storage_bytes) + BigInt(prepared.bytes.length) > BigInt(quota.rows[0].max_storage_bytes!))
          conflict('Limite de armazenamento atingido');
        const tenant = await client.query<{ id: string }>('SELECT app.current_tenant_id() AS id');
        const saved = await savePhoto(config,tenant.rows[0]!.id,id,prepared.bytes);
        pendingFiles.push(saved.key);
        const event = await client.query<{ id: string }>(`INSERT INTO app.delivery_events
          (tenant_id,delivery_id,actor_membership_id,kind,occurred_at,note,client_operation_id,metadata)
          VALUES (app.current_tenant_id(),$1,$2,'completed',$3,$4,$5,jsonb_build_object('request_hash',$6::text)) RETURNING id`,
          [id,identity.membershipId,fields.occurredAt,fields.note ?? null,fields.clientOperationId,requestHash]);
        await client.query(`INSERT INTO app.delivery_photos(tenant_id,delivery_id,event_id,storage_key,mime_type,byte_size,sha256,captured_at)
          VALUES (app.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7)`,
          [id,event.rows[0]!.id,saved.key,saved.mime,saved.size,saved.hash,fields.occurredAt]);
        await client.query(`UPDATE app.deliveries SET status='completed',completed_at=now(),updated_at=now() WHERE id=$1`, [id]);
        const stopped = await client.query<{ tenant_id:string; route_id:string }>(`UPDATE app.delivery_route_stops s
          SET status='completed'
          FROM app.delivery_routes r
          WHERE s.tenant_id=r.tenant_id AND s.route_id=r.id AND s.delivery_id=$1
            AND r.courier_membership_id=$2 AND r.status='active' AND s.status IN ('active','pending')
          RETURNING s.tenant_id,s.route_id`,[id,identity.membershipId]);
        for (const route of stopped.rows) {
          await client.query(`UPDATE app.delivery_route_stops SET status='active'
            WHERE tenant_id=$1 AND route_id=$2 AND status='pending'
              AND position=(SELECT min(position) FROM app.delivery_route_stops WHERE tenant_id=$1 AND route_id=$2 AND status='pending')`,[route.tenant_id,route.route_id]);
          await client.query(`UPDATE app.delivery_routes SET status='completed',completed_at=now()
            WHERE tenant_id=$1 AND id=$2 AND status='active'
              AND NOT EXISTS(SELECT 1 FROM app.delivery_route_stops WHERE tenant_id=$1 AND route_id=$2 AND status IN ('pending','active'))`,[route.tenant_id,route.route_id]);
        }
        return { eventId: event.rows[0]!.id, replayed: false };
      });
    } catch (error) {
      for (const key of pendingFiles) await removePhoto(config,key);
      throw error;
    }
  });

  app.get('/v1/delivery-photos/:id', { schema: { tags: ['files'], params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request,reply) => {
    const { identity } = await authenticate(request,pools);
    if (identity.scope !== 'tenant') forbidden();
    const { id } = request.params as { id: string };
    const photo = await withTenant(pools,identity,async client => {
      const result = await client.query<{ storage_key: string; mime_type: string }>(
        'SELECT storage_key,mime_type FROM app.delivery_photos WHERE id=$1', [id]);
      return result.rows[0] ?? notFound();
    });
    reply.type(photo.mime_type).header('Cache-Control','private, no-store');
    return reply.send(readPhoto(config,photo.storage_key));
  });
}
