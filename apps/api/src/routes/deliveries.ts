import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { DbPools, Identity } from '../db.js';
import type { ApiConfig } from '../config.js';
import { withTenant } from '../db.js';
import { authenticate } from '../auth.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { sha256 } from '../security.js';
import { preparePhoto, savePhoto, removePhoto } from '../storage.js';

const uuid = { type: 'string', format: 'uuid' };

async function tenantIdentity(request: FastifyRequest, pools: DbPools): Promise<Identity> {
  const { identity } = await authenticate(request, pools);
  if (identity.scope !== 'tenant') forbidden();
  return identity;
}
function requireAdmin(identity: Identity): void { if (identity.role !== 'admin') forbidden(); }
function requireCourier(identity: Identity): void { if (identity.role !== 'courier') forbidden(); }
async function geocodeInlineAddress(address: {street:string;number?:string;neighborhood?:string;city:string;state:string;postalCode?:string}) {
  const query=[address.street,address.number,address.neighborhood,address.city,address.state,address.postalCode,'Brasil'].filter(Boolean).join(', ');
  try { const response=await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`,{headers:{'User-Agent':'EntregaJa/0.1 (delivery address geocoding; support@entregaja.app)','Accept-Language':'pt-BR'},signal:AbortSignal.timeout(8000)}); if(!response.ok)return null; const rows=await response.json() as Array<{lat?:string;lon?:string}>; const latitude=Number(rows[0]?.lat),longitude=Number(rows[0]?.lon); return Number.isFinite(latitude)&&Number.isFinite(longitude)?{latitude,longitude}:null; } catch { return null; }
}

async function outbox(client: PoolClient, deliveryId: string, courierMembershipId: string, eventType: 'delivery_assigned' | 'delivery_reassigned') {
  await client.query(`INSERT INTO app.notification_outbox(tenant_id,delivery_id,device_id,event_type)
    SELECT app.current_tenant_id(),$1,d.id,$3 FROM app.devices d
    WHERE d.membership_id=$2 AND d.revoked_at IS NULL AND d.fcm_token IS NOT NULL`,
    [deliveryId, courierMembershipId, eventType]);
}

async function detachDeliveryFromActiveRoutes(client: PoolClient, deliveryId: string) {
  const routes = await client.query<{ tenant_id:string; route_id:string }>(`SELECT r.tenant_id,r.id AS route_id
    FROM app.delivery_route_stops s
    JOIN app.delivery_routes r ON r.tenant_id=s.tenant_id AND r.id=s.route_id
    WHERE s.delivery_id=$1 AND r.status='active' AND s.status IN ('active','pending')
    FOR UPDATE OF r`,[deliveryId]);
  for (const route of routes.rows) {
    await client.query(`UPDATE app.delivery_route_stops SET status='skipped'
      WHERE tenant_id=$1 AND route_id=$2 AND delivery_id=$3 AND status IN ('active','pending')`,
      [route.tenant_id,route.route_id,deliveryId]);
    await client.query(`UPDATE app.delivery_route_stops SET status='active'
      WHERE tenant_id=$1 AND route_id=$2 AND status='pending'
        AND NOT EXISTS(SELECT 1 FROM app.delivery_route_stops WHERE tenant_id=$1 AND route_id=$2 AND status='active')
        AND position=(SELECT min(position) FROM app.delivery_route_stops WHERE tenant_id=$1 AND route_id=$2 AND status='pending')`,
      [route.tenant_id,route.route_id]);
    await client.query(`UPDATE app.delivery_routes SET status=CASE
        WHEN EXISTS(SELECT 1 FROM app.delivery_route_stops WHERE tenant_id=$1 AND route_id=$2 AND status='completed') THEN 'completed'
        ELSE 'cancelled' END,
        completed_at=CASE WHEN EXISTS(SELECT 1 FROM app.delivery_route_stops WHERE tenant_id=$1 AND route_id=$2 AND status='completed') THEN now() ELSE completed_at END
      WHERE tenant_id=$1 AND id=$2 AND status='active'
        AND NOT EXISTS(SELECT 1 FROM app.delivery_route_stops WHERE tenant_id=$1 AND route_id=$2 AND status IN ('pending','active'))`,
      [route.tenant_id,route.route_id]);
  }
}

async function deliveryForUpdate(client: PoolClient, id: string) {
  const result = await client.query<{ id: string; status: string; courier_membership_id: string | null; customer_id: string; address_id: string }>(
    'SELECT id,status,courier_membership_id,customer_id,address_id FROM app.deliveries WHERE id=$1 FOR UPDATE', [id]);
  return result.rows[0] ?? notFound();
}

async function priorOperation(client: PoolClient, operationId: string, requestHash: string) {
  const result = await client.query<{ id: string; delivery_id: string; kind: string; metadata: { request_hash?: string } }>(
    'SELECT id,delivery_id,kind,metadata FROM app.delivery_events WHERE client_operation_id=$1', [operationId]);
  const event = result.rows[0];
  if (!event) return null;
  if (event.metadata.request_hash !== requestHash) conflict('Chave de operação reutilizada com conteúdo diferente');
  return event;
}

export async function lockOperation(client: PoolClient, operationId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,1))', [operationId]);
}

async function monthlyLimit(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended(app.current_tenant_id()::text,0))');
  const plan = await client.query<{ max_monthly_deliveries: number | null; status: string }>(`SELECT p.max_monthly_deliveries,s.status
    FROM app.subscriptions s JOIN app.plans p ON p.id=s.plan_id
    WHERE s.tenant_id=app.current_tenant_id() AND s.ended_at IS NULL`);
  const current = plan.rows[0];
  if (!current || current.status !== 'active') forbidden();
  if (current.max_monthly_deliveries !== null) {
    const usage = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM app.deliveries
      WHERE created_at>=date_trunc('month',now())`);
    if (Number(usage.rows[0]!.count) >= current.max_monthly_deliveries) conflict('Limite mensal de entregas atingido');
  }
}

export function registerDeliveryRoutes(app: FastifyInstance, pools: DbPools, config?: ApiConfig): void {
  app.get('/v1/deliveries', { schema: { tags: ['deliveries'], querystring: { type: 'object', properties: {
    status: { enum: ['pending','assigned','in_progress','completed','problem','cancelled'] },
    tab: { enum: ['open','finished'] }, day: { type: 'string', format: 'date' },
    customerId: uuid, addressId: uuid, courierMembershipId: uuid, cursor: uuid,
    search: { type: 'string', maxLength: 200 },
    from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' },
    limit: { type: 'integer', minimum: 1, maximum: 100 } } } } }, async request => {
    const identity = await tenantIdentity(request, pools);
    const q = request.query as Record<string, string | number | undefined>;
    return withTenant(pools, identity, async client => {
      const tab = (q.tab as string | undefined) ?? (q.day ? 'open' : null);
      const result = await client.query(`SELECT d.id,d.customer_id,d.address_id,d.courier_membership_id,d.is_claimable,d.status,
        d.merchandise_description,d.destination_snapshot,d.scheduled_for,d.assigned_at,d.viewed_at,d.completed_at,d.estimated_earnings_cents,d.created_at,
        coalesce((SELECT jsonb_agg(jsonb_build_object('id',di.id,'name',di.item_name,'icon_key',di.icon_key,'quantity',di.quantity) ORDER BY di.id) FROM app.delivery_items di WHERE di.tenant_id=d.tenant_id AND di.delivery_id=d.id),'[]'::jsonb) AS items,
        c.name AS customer_name,c.phone AS customer_phone FROM app.deliveries d JOIN app.customers c ON c.id=d.customer_id AND c.tenant_id=d.tenant_id
        WHERE ($1::text IS NULL OR d.status=$1)
        AND ($2::uuid IS NULL OR d.customer_id=$2) AND ($3::uuid IS NULL OR d.address_id=$3)
        AND ($4::uuid IS NULL OR d.courier_membership_id=$4) AND ($5::uuid IS NULL OR d.id<$5)
        AND ($6::timestamptz IS NULL OR d.created_at>=$6) AND ($7::timestamptz IS NULL OR d.created_at<=$7)
        AND ($8::text IS NULL OR c.name ILIKE '%'||$8||'%' OR d.merchandise_description ILIKE '%'||$8||'%'
          OR d.destination_snapshot::text ILIKE '%'||$8||'%')
        AND ($10::text IS NULL OR ($10='open' AND d.status NOT IN ('completed','cancelled'))
          OR ($10='finished' AND d.status IN ('completed','cancelled')))
        AND ($11::date IS NULL OR CASE
          WHEN $10='open' THEN (
            (d.scheduled_for IS NOT NULL AND (d.scheduled_for AT TIME ZONE 'America/Fortaleza')::date <= $11::date)
            OR (d.scheduled_for IS NULL AND (d.created_at AT TIME ZONE 'America/Fortaleza')::date = $11::date))
          WHEN $10='finished' THEN (coalesce(d.completed_at,d.cancelled_at,d.updated_at) AT TIME ZONE 'America/Fortaleza')::date = $11::date
          ELSE (d.created_at AT TIME ZONE 'America/Fortaleza')::date = $11::date END)
        ORDER BY d.id DESC LIMIT $9`, [q.status ?? null,q.customerId ?? null,q.addressId ?? null,
        identity.role === 'courier' ? identity.membershipId : q.courierMembershipId ?? null,
        q.cursor ?? null,q.from ?? null,q.to ?? null,q.search ?? null,q.limit ?? 50,tab,q.day ?? null]);
      return { items: result.rows, nextCursor: result.rows.at(-1)?.id ?? null };
    });
  });

  app.get('/v1/deliveries/:id', { schema: { tags: ['deliveries'], params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async request => {
    const identity = await tenantIdentity(request, pools);
    const { id } = request.params as { id: string };
    return withTenant(pools, identity, async client => {
      const delivery = await client.query('SELECT * FROM app.deliveries WHERE id=$1', [id]);
      if (!delivery.rows[0]) notFound();
      const route=await client.query(`SELECT r.id AS route_id FROM app.delivery_route_stops s JOIN app.delivery_routes r ON r.id=s.route_id AND r.tenant_id=s.tenant_id WHERE s.delivery_id=$1 AND s.tenant_id=app.current_tenant_id() ORDER BY (r.status='active') DESC,r.created_at DESC LIMIT 1`,[id]);
      const events = await client.query('SELECT * FROM app.delivery_events WHERE delivery_id=$1 ORDER BY id DESC LIMIT 50', [id]);
      const photos = await client.query(`SELECT id,event_id,mime_type,byte_size,sha256,captured_at,created_at
        FROM app.delivery_photos WHERE delivery_id=$1 ORDER BY id DESC LIMIT 50`, [id]);
      const items=await client.query(`SELECT id,catalog_item_id,item_name AS name,icon_key,quantity FROM app.delivery_items WHERE delivery_id=$1 ORDER BY id`,[id]);
      return { ...delivery.rows[0], route_id:route.rows[0]?.route_id??null, events: events.rows, photos: photos.rows,
        items:items.rows,
        eventsNextCursor: events.rows.at(-1)?.id ?? null, photosNextCursor: photos.rows.at(-1)?.id ?? null };
    });
  });

  app.get('/v1/deliveries/:id/events', { schema: { tags: ['deliveries'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    querystring: { type: 'object', properties: { cursor: uuid, limit: { type: 'integer', minimum: 1, maximum: 100 },
      kind: { enum: ['created','assigned','reassigned','viewed','check_in','completed','problem','cancelled','note'] } } } } }, async request => {
    const identity = await tenantIdentity(request,pools);
    const { id } = request.params as { id: string };
    const q = request.query as { cursor?: string; limit?: number; kind?: string };
    return withTenant(pools,identity,async client => {
      if (!(await client.query('SELECT 1 FROM app.deliveries WHERE id=$1',[id])).rowCount) notFound();
      const result = await client.query(`SELECT * FROM app.delivery_events WHERE delivery_id=$1
        AND ($2::uuid IS NULL OR id<$2) AND ($3::text IS NULL OR kind=$3)
        ORDER BY id DESC LIMIT $4`,[id,q.cursor ?? null,q.kind ?? null,q.limit ?? 50]);
      return { items: result.rows, nextCursor: result.rows.at(-1)?.id ?? null };
    });
  });

  app.get('/v1/deliveries/:id/photos', { schema: { tags: ['files'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    querystring: { type: 'object', properties: { cursor: uuid, limit: { type: 'integer', minimum: 1, maximum: 100 } } } } }, async request => {
    const identity = await tenantIdentity(request,pools);
    const { id } = request.params as { id: string };
    const q = request.query as { cursor?: string; limit?: number };
    return withTenant(pools,identity,async client => {
      if (!(await client.query('SELECT 1 FROM app.deliveries WHERE id=$1',[id])).rowCount) notFound();
      const result = await client.query(`SELECT id,event_id,mime_type,byte_size,sha256,captured_at,created_at
        FROM app.delivery_photos WHERE delivery_id=$1 AND ($2::uuid IS NULL OR id<$2)
        ORDER BY id DESC LIMIT $3`,[id,q.cursor ?? null,q.limit ?? 50]);
      return { items: result.rows, nextCursor: result.rows.at(-1)?.id ?? null };
    });
  });

  app.post('/v1/deliveries', { schema: { tags: ['deliveries'], body: { type: 'object',
    required: ['customerId'], properties: {
      customerId: uuid, addressId: uuid, courierMembershipId: uuid, claimable: { type: 'boolean' },
      address: { type: 'object', required: ['street','city','state'], properties: {
        label:{type:'string'},street:{type:'string',minLength:1},number:{type:'string'},complement:{type:'string'},
        neighborhood:{type:'string'},city:{type:'string',minLength:1},state:{type:'string',minLength:2,maxLength:2},postalCode:{type:'string'} }, additionalProperties:false },
      merchandiseDescription: { type: 'string', minLength: 1 },
      items: { type:'array',minItems:1,maxItems:30,items:{type:'object',required:['catalogItemId','quantity'],properties:{catalogItemId:uuid,quantity:{type:'integer',minimum:1,maximum:999}},additionalProperties:false} },
      instructions: { type: 'string' },
      scheduledFor: { type: 'string', format: 'date-time' }, estimatedEarningsCents: { type: 'integer', minimum: 0, maximum: 100000000 } }, additionalProperties: false } } }, async (request, reply) => {
    const identity = await tenantIdentity(request, pools); requireAdmin(identity);
    const b = request.body as { customerId: string; addressId?: string; address?: { label?:string; street:string; number?:string; complement?:string; neighborhood?:string; city:string; state:string; postalCode?:string }; courierMembershipId?: string; claimable?:boolean;
      merchandiseDescription?: string; items?:Array<{catalogItemId:string;quantity:number}>; instructions?: string; scheduledFor?: string; estimatedEarningsCents?: number };
    if ((!b.addressId && !b.address) || (b.addressId && b.address)) badRequest('Informe um endereço existente ou cadastre um novo endereço');
    if (b.claimable && b.courierMembershipId) badRequest('Uma entrega disponível não pode ter entregador atribuído');
    if(!b.items?.length&&!b.merchandiseDescription?.trim())badRequest('Adicione os volumes da entrega');
    const created = await withTenant(pools, identity, async client => {
      await monthlyLimit(client);
      let addressId=b.addressId;
      if(b.address){const coordinates=await geocodeInlineAddress(b.address);const inserted=await client.query<{id:string}>(`INSERT INTO app.addresses(tenant_id,customer_id,label,street,number,complement,neighborhood,city,state,postal_code,reference_latitude,reference_longitude,reference_updated_at)
        VALUES(app.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $10::numeric IS NULL THEN NULL ELSE now() END) RETURNING id`,[b.customerId,b.address.label??null,b.address.street,b.address.number??null,b.address.complement??null,b.address.neighborhood??null,b.address.city,b.address.state,b.address.postalCode??null,coordinates?.latitude??null,coordinates?.longitude??null]);addressId=inserted.rows[0]!.id;}
      const address = await client.query(`SELECT street,number,complement,neighborhood,city,state,postal_code,
        reference_latitude,reference_longitude FROM app.addresses
        WHERE id=$1 AND customer_id=$2 AND archived_at IS NULL`, [addressId,b.customerId]);
      if (!address.rows[0]) notFound();
      const selectedItems:Array<{id:string;name:string;icon_key:string;quantity:number}> = [];
      for(const requested of b.items??[]){const item=await client.query<{id:string;name:string;icon_key:string}>(`SELECT id,name,icon_key FROM app.tenant_delivery_items WHERE id=$1 AND archived_at IS NULL`,[requested.catalogItemId]);if(!item.rows[0])badRequest('Um dos volumes não está mais disponível no catálogo');selectedItems.push({...item.rows[0],quantity:requested.quantity});}
      const merchandiseDescription=selectedItems.length?selectedItems.map(item=>`${item.quantity}× ${item.name}`).join(' · '):b.merchandiseDescription!.trim();
      const result = await client.query<{ id: string }>(`INSERT INTO app.deliveries
        (tenant_id,customer_id,address_id,courier_membership_id,status,merchandise_description,is_claimable,
         instructions,destination_snapshot,scheduled_for,estimated_earnings_cents,assigned_at)
        VALUES (app.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END) RETURNING id`,
        [b.customerId,addressId,b.courierMembershipId ?? null,b.courierMembershipId ? 'assigned' : 'pending',
          merchandiseDescription,!!b.claimable,b.instructions ?? null,JSON.stringify(address.rows[0]),b.scheduledFor ?? null,b.estimatedEarningsCents ?? null]);
      const id = result.rows[0]!.id;
      for(const item of selectedItems)await client.query(`INSERT INTO app.delivery_items(tenant_id,delivery_id,catalog_item_id,item_name,icon_key,quantity) VALUES(app.current_tenant_id(),$1,$2,$3,$4,$5)`,[id,item.id,item.name,item.icon_key,item.quantity]);
      await client.query(`INSERT INTO app.delivery_events(tenant_id,delivery_id,actor_membership_id,kind)
        VALUES (app.current_tenant_id(),$1,$2,'created')`, [id,identity.membershipId]);
      if (b.courierMembershipId) {
        await client.query(`INSERT INTO app.delivery_events(tenant_id,delivery_id,actor_membership_id,kind,metadata)
          VALUES (app.current_tenant_id(),$1,$2,'assigned',jsonb_build_object('new_membership_id',$3::uuid))`,
          [id,identity.membershipId,b.courierMembershipId]);
        await outbox(client,id,b.courierMembershipId,'delivery_assigned');
      } else if (b.claimable) {
        await client.query(`INSERT INTO app.notification_outbox(tenant_id,delivery_id,device_id,event_type)
          SELECT app.current_tenant_id(),$1,dv.id,'delivery_available' FROM app.devices dv
          JOIN app.tenant_memberships m ON m.id=dv.membership_id AND m.tenant_id=dv.tenant_id
          WHERE dv.tenant_id=app.current_tenant_id() AND dv.revoked_at IS NULL AND dv.fcm_token IS NOT NULL
            AND m.role='courier' AND m.status='active'`,[id]);
      }
      return { id, claimable: !!b.claimable };
    });
    reply.status(201); return created;
  });

  app.post('/v1/deliveries/:id/claim', { schema: { tags:['mobile'], params:{type:'object',required:['id'],properties:{id:uuid}}, body:{type:'object',properties:{},additionalProperties:false} } }, async request => {
    const identity=await tenantIdentity(request,pools); requireCourier(identity); const {id}=request.params as {id:string};
    return withTenant(pools,identity,async client=>{
      const row=await client.query<{id:string}>('SELECT id FROM app.deliveries WHERE id=$1 AND is_claimable AND status=\'pending\' AND courier_membership_id IS NULL FOR UPDATE',[id]);
      if(!row.rowCount) conflict('Esta entrega não está mais disponível');
      await client.query(`UPDATE app.deliveries SET courier_membership_id=$1,status='assigned',is_claimable=false,assigned_at=now(),updated_at=now() WHERE id=$2`,[identity.membershipId,id]);
      await client.query('SELECT app.supersede_delivery_available_notifications($1)',[id]);
      await client.query(`INSERT INTO app.delivery_events(tenant_id,delivery_id,actor_membership_id,kind,metadata) VALUES(app.current_tenant_id(),$1,$2,'assigned','{"self_claimed":"true"}'::jsonb)`,[id,identity.membershipId]);
      return {id,status:'assigned'};
    });
  });

  app.patch('/v1/deliveries/:id', { schema: { tags: ['deliveries'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', minProperties: 1, properties: { customerId: uuid, addressId: uuid,
      merchandiseDescription: { type: 'string', minLength: 1 }, instructions: { type: ['string','null'] },
      scheduledFor: { type: ['string','null'] } }, additionalProperties: false } } }, async request => {
    const identity = await tenantIdentity(request,pools); requireAdmin(identity);
    const { id } = request.params as { id: string };
    const b = request.body as { customerId?: string; addressId?: string; merchandiseDescription?: string;
      instructions?: string | null; scheduledFor?: string | null };
    return withTenant(pools,identity,async client => {
      const current = await deliveryForUpdate(client,id);
      if (['completed','cancelled'].includes(current.status)) conflict('Entrega encerrada');
      const customerId = b.customerId ?? current.customer_id;
      const addressId = b.addressId ?? current.address_id;
      const destinationChanged = 'customerId' in b || 'addressId' in b;
      let snapshot: string | null = null;
      if (destinationChanged) {
        const address = await client.query(`SELECT street,number,complement,neighborhood,city,state,postal_code,
          reference_latitude,reference_longitude FROM app.addresses
          WHERE id=$1 AND customer_id=$2 AND archived_at IS NULL`,[addressId,customerId]);
        if (!address.rows[0]) notFound();
        snapshot = JSON.stringify(address.rows[0]);
      }
      const result = await client.query(`UPDATE app.deliveries SET customer_id=$1,address_id=$2,
        destination_snapshot=CASE WHEN $10::boolean THEN $3::jsonb ELSE destination_snapshot END,
        merchandise_description=coalesce($4,merchandise_description),
        instructions=CASE WHEN $5::boolean THEN $6 ELSE instructions END,
        scheduled_for=CASE WHEN $7::boolean THEN $8::timestamptz ELSE scheduled_for END,
        updated_at=now() WHERE id=$9 RETURNING *`,[customerId,addressId,snapshot,
          b.merchandiseDescription ?? null,'instructions' in b,b.instructions ?? null,
          'scheduledFor' in b,b.scheduledFor ?? null,id,destinationChanged]);
      await client.query(`INSERT INTO app.delivery_events(tenant_id,delivery_id,actor_membership_id,kind,metadata)
        VALUES (app.current_tenant_id(),$1,$2,'note',jsonb_build_object('edited_fields',$3::text[]))`,
        [id,identity.membershipId,Object.keys(b)]);
      return result.rows[0];
    });
  });

  app.post('/v1/deliveries/:id/assignment', { schema: { tags: ['deliveries'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', required: ['courierMembershipId'], properties: { courierMembershipId: uuid }, additionalProperties: false } } }, async request => {
    const identity = await tenantIdentity(request, pools); requireAdmin(identity);
    const { id } = request.params as { id: string };
    const { courierMembershipId } = request.body as { courierMembershipId: string };
    return withTenant(pools, identity, async client => {
      const delivery = await deliveryForUpdate(client,id);
      if (['completed','cancelled'].includes(delivery.status)) conflict('Entrega encerrada');
      if (delivery.courier_membership_id === courierMembershipId) return { id, unchanged: true };
      const kind = delivery.courier_membership_id ? 'reassigned' : 'assigned';
      await client.query(`UPDATE app.notification_outbox SET status='failed',last_error='superseded',processed_at=now()
        WHERE delivery_id=$1 AND status IN ('pending','processing')`, [id]);
      await client.query(`UPDATE app.deliveries SET courier_membership_id=$1,status='assigned',
        assigned_at=now(),viewed_at=NULL,updated_at=now() WHERE id=$2`, [courierMembershipId,id]);
      await detachDeliveryFromActiveRoutes(client,id);
      await client.query(`INSERT INTO app.delivery_events(tenant_id,delivery_id,actor_membership_id,kind,metadata)
        VALUES (app.current_tenant_id(),$1,$2,$3,
          jsonb_build_object('previous_membership_id',$4::uuid,'new_membership_id',$5::uuid))`,
        [id,identity.membershipId,kind,delivery.courier_membership_id,courierMembershipId]);
      if (delivery.courier_membership_id) await client.query(`INSERT INTO app.delivery_assignment_removals
        (tenant_id,delivery_id,membership_id) VALUES (app.current_tenant_id(),$1,$2)`,
        [id,delivery.courier_membership_id]);
      await outbox(client,id,courierMembershipId,kind === 'assigned' ? 'delivery_assigned' : 'delivery_reassigned');
      return { id, status: 'assigned', courierMembershipId };
    });
  });

  app.post('/v1/deliveries/:id/cancel', { schema: { tags: ['deliveries'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', properties: { note: { type: 'string' } }, additionalProperties: false } } }, async request => {
    const identity = await tenantIdentity(request, pools); requireAdmin(identity);
    const { id } = request.params as { id: string };
    const { note } = (request.body ?? {}) as { note?: string };
    return withTenant(pools, identity, async client => {
      const delivery = await deliveryForUpdate(client,id);
      if (['completed','cancelled'].includes(delivery.status)) conflict('Entrega encerrada');
      await client.query(`UPDATE app.notification_outbox SET status='failed',last_error='cancelled',processed_at=now()
        WHERE delivery_id=$1 AND status IN ('pending','processing')`, [id]);
      await client.query(`UPDATE app.deliveries SET status='cancelled',cancelled_at=now(),updated_at=now() WHERE id=$1`, [id]);
      await detachDeliveryFromActiveRoutes(client,id);
      await client.query(`INSERT INTO app.delivery_events(tenant_id,delivery_id,actor_membership_id,kind,note)
        VALUES (app.current_tenant_id(),$1,$2,'cancelled',$3)`, [id,identity.membershipId,note ?? null]);
      return { id, status: 'cancelled' };
    });
  });

  app.post('/v1/deliveries/:id/check-ins', { schema: { tags: ['mobile'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', required: ['clientOperationId','latitude','longitude','accuracyM','occurredAt'],
      properties: { clientOperationId: uuid, latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 }, accuracyM: { type: 'number', minimum: 0 },
        occurredAt: { type: 'string', format: 'date-time' }, note: { type: 'string' } }, additionalProperties: false } } }, async request => {
    const identity = await tenantIdentity(request, pools); requireCourier(identity);
    const { id } = request.params as { id: string };
    const b = request.body as { clientOperationId: string; latitude: number; longitude: number; accuracyM: number; occurredAt: string; note?: string };
    const hash = sha256(JSON.stringify({ id, kind: 'check_in', ...b }));
    return withTenant(pools, identity, async client => {
      await lockOperation(client,b.clientOperationId);
      const previous = await priorOperation(client,b.clientOperationId,hash);
      if (previous) return { id: previous.id, deliveryId: previous.delivery_id, replayed: true };
      const delivery = await deliveryForUpdate(client,id);
      if (delivery.courier_membership_id !== identity.membershipId) notFound();
      if (!['assigned','in_progress','problem'].includes(delivery.status)) conflict('Entrega não permite check-in');
      const inserted = await client.query<{ id: string }>(`INSERT INTO app.delivery_events
        (tenant_id,delivery_id,actor_membership_id,kind,occurred_at,latitude,longitude,gps_accuracy_m,note,client_operation_id,metadata)
        VALUES (app.current_tenant_id(),$1,$2,'check_in',$3,$4,$5,$6,$7,$8,jsonb_build_object('request_hash',$9::text)) RETURNING id`,
        [id,identity.membershipId,b.occurredAt,b.latitude,b.longitude,b.accuracyM,b.note ?? null,b.clientOperationId,hash]);
      if (delivery.status !== 'problem') {
        await client.query(`UPDATE app.deliveries SET status='in_progress',updated_at=now() WHERE id=$1`, [id]);
      }
      await client.query(`UPDATE app.addresses SET reference_latitude=$1,reference_longitude=$2,reference_updated_at=now(),updated_at=now()
        WHERE id=$3 AND customer_id=$4`, [b.latitude,b.longitude,delivery.address_id,delivery.customer_id]);
      await client.query(`UPDATE app.deliveries SET updated_at=now() WHERE address_id=$1 AND status NOT IN ('completed','cancelled')`, [delivery.address_id]);
      return { id: inserted.rows[0]!.id, deliveryId: id, replayed: false };
    });
  });

  app.post('/v1/deliveries/:id/note', { schema: { tags: ['mobile'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', required: ['clientOperationId','note','occurredAt'], properties: { clientOperationId: uuid, note: { type: 'string', minLength: 1 }, occurredAt: { type: 'string', format: 'date-time' } }, additionalProperties: false } } }, async request => {
    const identity = await tenantIdentity(request, pools); requireCourier(identity);
    const { id } = request.params as { id: string }; const b = request.body as { clientOperationId:string; note:string; occurredAt:string };
    return withTenant(pools,identity,async client => { await lockOperation(client,b.clientOperationId); const delivery=await deliveryForUpdate(client,id);
      if(delivery.courier_membership_id!==identity.membershipId)notFound(); if(!['assigned','in_progress','problem'].includes(delivery.status))conflict('Entrega encerrada');
      const hash=sha256(JSON.stringify({id,kind:'note',...b})); const previous=await priorOperation(client,b.clientOperationId,hash); if(previous)return { id: previous.id, replayed:true };
      const event=await client.query<{id:string}>(`INSERT INTO app.delivery_events(tenant_id,delivery_id,actor_membership_id,kind,note,occurred_at,client_operation_id,metadata)
        VALUES(app.current_tenant_id(),$1,$2,'note',$3,$4,$5,jsonb_build_object('request_hash',$6::text)) RETURNING id`,[id,identity.membershipId,b.note,b.occurredAt,b.clientOperationId,hash]); return { eventId:event.rows[0]!.id,replayed:false };
    });
  });

  app.post('/v1/deliveries/:id/view', { schema: { tags: ['mobile'], params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async request => {
    const identity = await tenantIdentity(request, pools); requireCourier(identity);
    const { id } = request.params as { id: string };
    return withTenant(pools, identity, async client => {
      const delivery = await deliveryForUpdate(client,id);
      if (delivery.courier_membership_id !== identity.membershipId) notFound();
      const updated = await client.query(`UPDATE app.deliveries SET viewed_at=coalesce(viewed_at,now()),updated_at=now()
        WHERE id=$1 AND viewed_at IS NULL RETURNING id`, [id]);
      if (updated.rowCount) await client.query(`INSERT INTO app.delivery_events(tenant_id,delivery_id,actor_membership_id,kind)
        VALUES (app.current_tenant_id(),$1,$2,'viewed')`, [id,identity.membershipId]);
      return { id, viewed: true };
    });
  });

  app.post('/v1/deliveries/:id/photos', { schema: { tags: ['mobile'], params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async request => {
    const identity=await tenantIdentity(request,pools); requireCourier(identity); if(!config) badRequest('Fotos indisponíveis');
    const {id}=request.params as {id:string}; const fields:Record<string,string>={}; let photo:Buffer|null=null; let mime='';
    for await(const part of request.parts()){if(part.type==='file'){if(part.fieldname!=='photo'||photo)badRequest('Foto inválida');mime=part.mimetype;photo=await part.toBuffer();}else fields[part.fieldname]=String(part.value);}
    if(!photo||!fields.clientOperationId||!fields.occurredAt)badRequest('Dados da foto inválidos'); const prepared=await preparePhoto(photo,mime); const keys:string[]=[];
    try{return await withTenant(pools,identity,async client=>{await lockOperation(client,fields.clientOperationId!);const delivery=await deliveryForUpdate(client,id);if(delivery.courier_membership_id!==identity.membershipId)notFound();
      const existing=await client.query<{id:string}>('SELECT id FROM app.delivery_events WHERE client_operation_id=$1',[fields.clientOperationId]);if(existing.rows[0])return {eventId:existing.rows[0].id,replayed:true};
      const tenant=await client.query<{id:string}>('SELECT app.current_tenant_id() AS id');const saved=await savePhoto(config!,tenant.rows[0]!.id,id,prepared.bytes);keys.push(saved.key);
      const event=await client.query<{id:string}>(`INSERT INTO app.delivery_events(tenant_id,delivery_id,actor_membership_id,kind,occurred_at,note,client_operation_id) VALUES(app.current_tenant_id(),$1,$2,'note',$3,'Foto adicionada',$4) RETURNING id`,[id,identity.membershipId,fields.occurredAt,fields.clientOperationId]);
      await client.query(`INSERT INTO app.delivery_photos(tenant_id,delivery_id,event_id,storage_key,mime_type,byte_size,sha256,captured_at) VALUES(app.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7)`,[id,event.rows[0]!.id,saved.key,saved.mime,saved.size,saved.hash,fields.occurredAt]);return {eventId:event.rows[0]!.id,replayed:false};});}catch(error){for(const key of keys)await removePhoto(config!,key);throw error;}
  });

  app.post('/v1/deliveries/:id/problem', { schema: { tags: ['mobile'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', required: ['clientOperationId','note'], properties: { clientOperationId: uuid,
      note: { type: 'string', minLength: 1 }, reasonCode: { type: 'string', pattern: '^[a-z0-9_]+$' } }, additionalProperties: false } } }, async request => {
    const identity = await tenantIdentity(request, pools); requireCourier(identity);
    const { id } = request.params as { id: string };
    const b = request.body as { clientOperationId: string; note: string; reasonCode?: string };
    const hash = sha256(JSON.stringify({ id, kind: 'problem', ...b }));
    return withTenant(pools, identity, async client => {
      await lockOperation(client,b.clientOperationId);
      const previous = await priorOperation(client,b.clientOperationId,hash);
      if (previous) return { id: previous.id, replayed: true };
      const delivery = await deliveryForUpdate(client,id);
      if (delivery.courier_membership_id !== identity.membershipId) notFound();
      if (!['assigned','in_progress'].includes(delivery.status)) conflict('Entrega encerrada');
      const reason = b.reasonCode ? await client.query<{ id: string }>('SELECT id FROM app.problem_reasons WHERE tenant_id=app.current_tenant_id() AND code=$1 AND active',[b.reasonCode]) : { rows: [] as { id: string }[] };
      const event = await client.query<{ id: string }>(`INSERT INTO app.delivery_events
        (tenant_id,delivery_id,actor_membership_id,kind,note,problem_reason_id,client_operation_id,metadata)
        VALUES (app.current_tenant_id(),$1,$2,'problem',$3,$4,$5,jsonb_build_object('request_hash',$6::text)) RETURNING id`,
        [id,identity.membershipId,b.note,reason.rows[0]?.id ?? null,b.clientOperationId,hash]);
      await client.query(`UPDATE app.deliveries SET status='problem',updated_at=now() WHERE id=$1`, [id]);
      return { id: event.rows[0]!.id, replayed: false };
    });
  });

  app.post('/v1/deliveries/:id/problem-report', { schema: { tags: ['mobile'], params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async request => {
    const identity = await tenantIdentity(request, pools); requireCourier(identity);
    if (!config) badRequest('Relatório de problema indisponível');
    const { id } = request.params as { id: string };
    const fields: Record<string,string> = {}; let photo: Buffer | null = null; let declaredMime = '';
    for await (const part of request.parts()) {
      if (part.type === 'file') { if (part.fieldname !== 'photo' || photo) badRequest('Foto inválida'); declaredMime = part.mimetype; photo = await part.toBuffer(); }
      else fields[part.fieldname] = String(part.value);
    }
    if (!fields.clientOperationId || !fields.occurredAt || !fields.note || !/^[0-9a-f-]{36}$/i.test(fields.clientOperationId)) badRequest('Dados do problema inválidos');
    const prepared = photo ? await preparePhoto(photo,declaredMime) : null;
    const hash = sha256(JSON.stringify({ id, kind:'problem', operation:fields.clientOperationId, occurredAt:fields.occurredAt, note:fields.note, reasonCode:fields.reasonCode ?? null, photoHash:prepared?.sourceHash ?? null }));
    const pendingFiles: string[] = [];
    try {
      return await withTenant(pools,identity,async client => {
        await lockOperation(client,fields.clientOperationId!);
        const previous = await client.query<{ id:string; delivery_id:string; metadata:{request_hash?:string} }>('SELECT id,delivery_id,metadata FROM app.delivery_events WHERE client_operation_id=$1',[fields.clientOperationId]);
        if(previous.rows[0]){if(previous.rows[0].metadata.request_hash!==hash||previous.rows[0].delivery_id!==id)conflict('Chave de operação reutilizada com conteúdo diferente');return {eventId:previous.rows[0].id,replayed:true};}
        const delivery=await client.query<{status:string;courier_membership_id:string}>('SELECT status,courier_membership_id FROM app.deliveries WHERE id=$1 FOR UPDATE',[id]);
        if(!delivery.rows[0]||delivery.rows[0].courier_membership_id!==identity.membershipId)notFound();
        if(!['assigned','in_progress'].includes(delivery.rows[0]!.status))conflict('Entrega encerrada');
        const reason=fields.reasonCode?await client.query<{id:string}>('SELECT id FROM app.problem_reasons WHERE tenant_id=app.current_tenant_id() AND code=$1 AND active',[fields.reasonCode]):{rows:[] as {id:string}[]};
        const event=await client.query<{id:string}>(`INSERT INTO app.delivery_events(tenant_id,delivery_id,actor_membership_id,kind,note,problem_reason_id,occurred_at,client_operation_id,metadata) VALUES(app.current_tenant_id(),$1,$2,'problem',$3,$4,$5,$6,jsonb_build_object('request_hash',$7::text)) RETURNING id`,[id,identity.membershipId,fields.note,reason.rows[0]?.id??null,fields.occurredAt,fields.clientOperationId,hash]);
        if(prepared){const tenant=await client.query<{id:string}>('SELECT app.current_tenant_id() AS id');const saved=await savePhoto(config!,tenant.rows[0]!.id,id,prepared.bytes);pendingFiles.push(saved.key);await client.query(`INSERT INTO app.delivery_photos(tenant_id,delivery_id,event_id,storage_key,mime_type,byte_size,sha256,captured_at) VALUES(app.current_tenant_id(),$1,$2,$3,$4,$5,$6,$7)`,[id,event.rows[0]!.id,saved.key,saved.mime,saved.size,saved.hash,fields.occurredAt]);}
        await client.query(`UPDATE app.deliveries SET status='problem',updated_at=now() WHERE id=$1`,[id]);
        return {eventId:event.rows[0]!.id,replayed:false};
      });
    } catch(error){for(const key of pendingFiles)await removePhoto(config!,key);throw error;}
  });
}
