import type { FastifyInstance } from 'fastify';
import type { DbPools } from '../db.js';
import { inTransaction } from '../db.js';
import { authenticate, createInvite } from '../auth.js';
import { badRequest, forbidden, notFound } from '../errors.js';

const uuid = { type: 'string', format: 'uuid' };
const email = { type: 'string', format: 'email' };

export function registerPlatformRoutes(app: FastifyInstance, pools: DbPools): void {
  const platform = async (request: Parameters<typeof authenticate>[0]) => {
    const { identity } = await authenticate(request, pools);
    if (identity.scope !== 'platform') forbidden();
    return identity;
  };

  app.get('/v1/platform/tenants', { schema: { tags: ['platform'], querystring: { type: 'object', properties: {
    cursor: uuid, limit: { type: 'integer', minimum: 1, maximum: 100 }, status: { enum: ['active','suspended','closed'] }, search: { type: 'string', maxLength: 200 } } } } }, async request => {
    await platform(request);
    const q = request.query as { cursor?: string; limit?: number; status?: string; search?: string };
    const result = await pools.platform.query(`SELECT id,name,legal_name,cnpj,contact_email,status,created_at
      FROM app.tenants WHERE ($1::uuid IS NULL OR id<$1) AND ($2::text IS NULL OR status=$2)
        AND ($3::text IS NULL OR name ILIKE '%'||$3||'%' OR coalesce(contact_email,'') ILIKE '%'||$3||'%'
          OR coalesce(cnpj,'') ILIKE '%'||$3||'%')
      ORDER BY id DESC LIMIT $4`, [q.cursor ?? null,q.status ?? null,q.search ?? null,q.limit ?? 50]);
    return { items: result.rows, nextCursor: result.rows.at(-1)?.id ?? null };
  });

  app.post('/v1/platform/tenants', { schema: { tags: ['platform'], body: { type: 'object',
    required: ['name','adminEmail'], properties: { name: { type: 'string', minLength: 1 },
      legalName: { type: 'string' }, cnpj: { type: 'string', pattern: '^[0-9]{14}$' },
      contactEmail: email, adminEmail: email }, additionalProperties: false } } }, async (request, reply) => {
    const identity = await platform(request);
    const body = request.body as { name: string; legalName?: string; cnpj?: string; contactEmail?: string; adminEmail: string };
    const result = await inTransaction(pools.platform, async client => {
      const tenant = await client.query<{ id: string }>(`INSERT INTO app.tenants(name,legal_name,cnpj,contact_email)
        VALUES ($1,$2,$3,$4) RETURNING id`, [body.name, body.legalName ?? null, body.cnpj ?? null, body.contactEmail ?? null]);
      const tenantId = tenant.rows[0]!.id;
      const invite = await createInvite(client, { email: body.adminEmail, purpose: 'invite', tenantId, role: 'admin', actorId: identity.userId });
      await client.query(`INSERT INTO app.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id)
        VALUES ($1,$2,'tenant.created','tenant',$1)`, [tenantId, identity.userId]);
      return { id: tenantId, adminInvite: invite };
    });
    reply.status(201);
    return result;
  });

  app.patch('/v1/platform/tenants/:id/status', { schema: { tags: ['platform'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', required: ['status'], properties: { status: { enum: ['active','suspended','closed'] } }, additionalProperties: false } } }, async request => {
    const identity = await platform(request);
    const { id } = request.params as { id: string };
    const { status } = request.body as { status: string };
    return inTransaction(pools.platform, async client => {
      const updated = await client.query('UPDATE app.tenants SET status=$1,updated_at=now() WHERE id=$2 RETURNING id,status', [status, id]);
      if (!updated.rows[0]) notFound();
      await client.query(`INSERT INTO app.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,details)
        VALUES ($1,$2,'tenant.status_changed','tenant',$1,jsonb_build_object('status',$3::text))`, [id, identity.userId, status]);
      return updated.rows[0];
    });
  });

  app.patch('/v1/platform/tenants/:id', { schema: { tags: ['platform'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', minProperties: 1, properties: { name: { type: 'string', minLength: 1 },
      legalName: { type: ['string','null'] }, cnpj: { type: ['string','null'] },
      contactEmail: { type: ['string','null'] } }, additionalProperties: false } } }, async request => {
    const identity = await platform(request);
    const { id } = request.params as { id: string };
    const b = request.body as Record<string,unknown>;
    const columns: Record<string,string> = { name:'name',legalName:'legal_name',cnpj:'cnpj',contactEmail:'contact_email' };
    const values: unknown[] = [];
    const sets = Object.entries(b).map(([key,value]) => {
      if (!columns[key]) badRequest('Campo inválido');
      values.push(value); return `${columns[key]}=$${values.length}`;
    });
    values.push(id);
    return inTransaction(pools.platform,async client => {
      const result = await client.query(`UPDATE app.tenants SET ${sets.join(',')},updated_at=now()
        WHERE id=$${values.length} RETURNING *`,values);
      if (!result.rows[0]) notFound();
      await client.query(`INSERT INTO app.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,details)
        VALUES ($1,$2,'tenant.updated','tenant',$1,jsonb_build_object('fields',$3::text[]))`,
        [id,identity.userId,Object.keys(b)]);
      return result.rows[0];
    });
  });

  app.get('/v1/platform/plans', { schema: { tags: ['platform'], querystring: { type: 'object', properties: {
    cursor: uuid, limit: { type: 'integer', minimum: 1, maximum: 100 }, active: { type: 'boolean' },
    search: { type: 'string' } } } } }, async request => {
    await platform(request);
    const q = request.query as { cursor?: string; limit?: number; active?: boolean; search?: string };
    const result = await pools.platform.query(`SELECT * FROM app.plans
      WHERE ($1::uuid IS NULL OR id<$1) AND ($2::boolean IS NULL OR active=$2)
        AND ($3::text IS NULL OR name ILIKE '%' || $3 || '%')
      ORDER BY id DESC LIMIT $4`,[q.cursor ?? null,q.active ?? null,q.search ?? null,q.limit ?? 50]);
    return { items: result.rows, nextCursor: result.rows.at(-1)?.id ?? null };
  });

  app.post('/v1/platform/plans', { schema: { tags: ['platform'], body: { type: 'object', required: ['name'],
    properties: { name: { type: 'string', minLength: 1 }, maxCouriers: { type: 'integer', minimum: 1 },
      maxUsers: { type: 'integer', minimum: 1 }, maxMonthlyDeliveries: { type: 'integer', minimum: 1 },
      maxStorageBytes: { type: 'integer', minimum: 1 } }, additionalProperties: false } } }, async (request, reply) => {
    const identity = await platform(request);
    const body = request.body as { name: string; maxCouriers?: number; maxUsers?: number; maxMonthlyDeliveries?: number; maxStorageBytes?: number };
    const result = await inTransaction(pools.platform, async client => {
      const inserted = await client.query(`INSERT INTO app.plans(name,max_couriers,max_users,max_monthly_deliveries,max_storage_bytes)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`, [body.name, body.maxCouriers ?? null, body.maxUsers ?? null,
        body.maxMonthlyDeliveries ?? null, body.maxStorageBytes ?? null]);
      await client.query(`INSERT INTO app.audit_logs(actor_user_id,action,entity_type,entity_id)
        VALUES ($1,'plan.created','plan',$2)`, [identity.userId, inserted.rows[0].id]);
      return inserted.rows[0];
    });
    reply.status(201);
    return result;
  });

  app.patch('/v1/platform/plans/:id', { schema: { tags: ['platform'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', minProperties: 1, properties: { name: { type: 'string', minLength: 1 },
      maxCouriers: { type: ['integer','null'] }, maxUsers: { type: ['integer','null'] },
      maxMonthlyDeliveries: { type: ['integer','null'] }, maxStorageBytes: { type: ['integer','null'] },
      active: { type: 'boolean' } }, additionalProperties: false } } }, async request => {
    const identity = await platform(request);
    const { id } = request.params as { id: string };
    const b = request.body as Record<string,unknown>;
    const columns: Record<string,string> = { name:'name',maxCouriers:'max_couriers',maxUsers:'max_users',
      maxMonthlyDeliveries:'max_monthly_deliveries',maxStorageBytes:'max_storage_bytes',active:'active' };
    const values: unknown[] = [];
    const sets = Object.entries(b).map(([key,value]) => {
      if (!columns[key]) badRequest('Campo inválido');
      values.push(value); return `${columns[key]}=$${values.length}`;
    });
    values.push(id);
    return inTransaction(pools.platform,async client => {
      const result = await client.query(`UPDATE app.plans SET ${sets.join(',')} WHERE id=$${values.length} RETURNING *`,values);
      if (!result.rows[0]) notFound();
      await client.query(`INSERT INTO app.audit_logs(actor_user_id,action,entity_type,entity_id,details)
        VALUES ($1,'plan.updated','plan',$2,jsonb_build_object('fields',$3::text[]))`,
        [identity.userId,id,Object.keys(b)]);
      return result.rows[0];
    });
  });

  app.get('/v1/platform/subscriptions', { schema: { tags: ['platform'], querystring: { type: 'object', properties: {
    cursor: uuid, limit: { type: 'integer', minimum: 1, maximum: 100 }, tenantId: uuid,
    status: { enum: ['active','suspended','ended'] } } } } }, async request => {
    await platform(request);
    const q = request.query as { cursor?: string; limit?: number; tenantId?: string; status?: string };
    const result = await pools.platform.query(`SELECT s.*,p.name AS plan_name FROM app.subscriptions s
      JOIN app.plans p ON p.id=s.plan_id WHERE ($1::uuid IS NULL OR s.id<$1)
      AND ($2::uuid IS NULL OR s.tenant_id=$2) AND ($3::text IS NULL OR s.status=$3)
      ORDER BY s.id DESC LIMIT $4`,[q.cursor ?? null,q.tenantId ?? null,q.status ?? null,q.limit ?? 50]);
    return { items: result.rows, nextCursor: result.rows.at(-1)?.id ?? null };
  });

  app.post('/v1/platform/subscriptions', { schema: { tags: ['platform'], body: { type: 'object',
    required: ['tenantId','planId'], properties: { tenantId: uuid, planId: uuid, notes: { type: 'string' } },
    additionalProperties: false } } }, async (request, reply) => {
    const identity = await platform(request);
    const body = request.body as { tenantId: string; planId: string; notes?: string };
    const result = await inTransaction(pools.platform, async client => {
      const inserted = await client.query(`INSERT INTO app.subscriptions(tenant_id,plan_id,status,started_at,notes)
        VALUES ($1,$2,'active',now(),$3) RETURNING *`, [body.tenantId, body.planId, body.notes ?? null]);
      await client.query(`INSERT INTO app.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id)
        VALUES ($1,$2,'subscription.created','subscription',$3)`, [body.tenantId, identity.userId, inserted.rows[0].id]);
      return inserted.rows[0];
    });
    reply.status(201);
    return result;
  });

  app.patch('/v1/platform/subscriptions/:id/status', { schema: { tags: ['platform'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', required: ['status'], properties: { status: { enum: ['active','suspended','ended'] } }, additionalProperties: false } } }, async request => {
    const identity = await platform(request);
    const { id } = request.params as { id: string };
    const { status } = request.body as { status: string };
    return inTransaction(pools.platform, async client => {
      const result = await client.query(`UPDATE app.subscriptions SET status=$1,
        ended_at=CASE WHEN $1='ended' THEN now() ELSE NULL END WHERE id=$2 RETURNING *`, [status, id]);
      const row = result.rows[0];
      if (!row) notFound();
      await client.query(`INSERT INTO app.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,details)
        VALUES ($1,$2,'subscription.status_changed','subscription',$3,jsonb_build_object('status',$4::text))`,
        [row.tenant_id, identity.userId, id, status]);
      return row;
    });
  });

  app.get('/v1/platform/usage', { schema: { tags: ['platform'], querystring: { type: 'object', properties: {
    cursor: uuid, limit: { type: 'integer', minimum: 1, maximum: 100 } } } } }, async request => {
    await platform(request);
    const q = request.query as { cursor?: string; limit?: number };
    const result = await pools.platform.query(`SELECT u.*,t.name AS tenant_name
      FROM app.platform_usage_summary() AS u JOIN app.tenants AS t ON t.id=u.tenant_id
      WHERE ($1::uuid IS NULL OR u.tenant_id<$1) ORDER BY u.tenant_id DESC LIMIT $2`,
      [q.cursor ?? null,q.limit ?? 50]);
    return { items: result.rows, nextCursor: result.rows.at(-1)?.tenant_id ?? null };
  });

  app.post('/v1/platform/tenants/:id/invites', { schema: { tags: ['platform'], params: { type: 'object', required: ['id'], properties: { id: uuid } },
    body: { type: 'object', required: ['email'], properties: { email }, additionalProperties: false } } }, async (request, reply) => {
    const identity = await platform(request);
    const { id } = request.params as { id: string };
    const { email: address } = request.body as { email: string };
    const tenant = await pools.platform.query('SELECT id FROM app.tenants WHERE id=$1', [id]);
    if (!tenant.rowCount) notFound();
    const invite = await inTransaction(pools.platform, async client => {
      const created = await createInvite(client, {
        email: address, purpose: 'invite', tenantId: id, role: 'admin', actorId: identity.userId,
      });
      await client.query(`INSERT INTO app.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id)
        VALUES ($1,$2,'tenant.admin_invited','invite',$3)`,[id,identity.userId,created.id]);
      return created;
    });
    reply.status(201);
    return invite;
  });

  app.post('/v1/platform/admins/:id/password-reset', { schema: { tags: ['platform'], params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request,reply) => {
    const identity = await platform(request);
    const { id } = request.params as { id: string };
    const invite = await inTransaction(pools.auth,async client => {
      const user = await client.query<{ email: string }>(
        'SELECT email FROM app.users WHERE id=$1 AND is_platform_admin=true',[id]);
      if (!user.rows[0]) notFound();
      const created = await createInvite(client,{email:user.rows[0].email,purpose:'password_reset',actorId:identity.userId});
      await client.query(`INSERT INTO app.audit_logs(actor_user_id,action,entity_type,entity_id)
        VALUES ($1,'platform.password_reset_issued','user',$2)`,[identity.userId,id]);
      return created;
    });
    reply.status(201); return invite;
  });
}
