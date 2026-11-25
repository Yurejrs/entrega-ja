import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../config.js';
import type { DbPools } from '../db.js';
import { acceptInvite, authenticate, inviteDetails, login, setSessionCookie, startMfa, verifyMfa } from '../auth.js';
import { badRequest } from '../errors.js';
import { newToken, sha256 } from '../security.js';

export function registerAuthRoutes(app: FastifyInstance, pools: DbPools, config: ApiConfig): void {
  app.post('/v1/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['auth'], body: { type: 'object', required: ['email','password','scope','client'],
      properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' },
        scope: { enum: ['tenant','platform'] }, client: { enum: ['web','mobile'] } }, additionalProperties: false } },
  }, async (request, reply) => {
    const body = request.body as { email: string; password: string; scope: 'tenant' | 'platform'; client: 'web' | 'mobile' };
    const result = await login(pools, body.email, body.password, body.scope, body.client);
    if (body.client === 'web') setSessionCookie(reply, result.token, config);
    return { user: result.user, scope: result.scope, role: result.role, tenant: result.tenant,
      mfaRequired: result.mfaRequired, expiresAt: result.expiresAt,
      ...(body.client === 'mobile' ? { token: result.token } : { csrfToken: result.csrf }) };
  });

  app.get('/v1/auth/me', { schema: { tags: ['auth'] } }, async request => {
    const { identity, session } = await authenticate(request, pools);
    const result = await pools.auth.query<{ email: string; full_name: string }>('SELECT email,full_name FROM app.users WHERE id=$1', [identity.userId]);
    return { ...identity, email: result.rows[0]?.email, fullName: result.rows[0]?.full_name,
      tenant: session.tenant_id ? { id: session.tenant_id, name: session.tenant_name } : null };
  });

  app.get('/v1/auth/csrf', { schema: { tags: ['auth'] } }, async request => {
    const { session, cookie } = await authenticate(request, pools, true);
    if (!cookie || !session.csrf_hash) badRequest('Sessão web necessária');
    const csrfToken = newToken();
    await pools.auth.query('UPDATE app.auth_sessions SET csrf_hash=$1 WHERE id=$2', [sha256(csrfToken), session.id]);
    return { csrfToken };
  });

  app.post('/v1/auth/logout', { schema: { tags: ['auth'] } }, async (request, reply) => {
    const { session } = await authenticate(request, pools, true);
    await pools.auth.query('UPDATE app.auth_sessions SET revoked_at=now() WHERE id=$1', [session.id]);
    reply.clearCookie('session', { path: '/v1' });
    return { ok: true };
  });

  app.post('/v1/auth/mfa/setup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: { tags: ['auth'] } }, async request => {
    const { session, identity } = await authenticate(request, pools, true);
    if (identity.role === 'courier') badRequest('MFA reservado a administradores');
    return startMfa(pools, session, config);
  });

  app.post('/v1/auth/mfa/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['auth'], body: { type: 'object', required: ['code'],
    properties: { code: { type: 'string', minLength: 6, maxLength: 32 } }, additionalProperties: false } } }, async request => {
    const { session } = await authenticate(request, pools, true);
    const { code } = request.body as { code: string };
    return verifyMfa(pools, session, code, config);
  });

  app.get('/v1/auth/invites/:token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['auth'], params: { type: 'object', required: ['token'], properties: { token: { type: 'string', minLength: 20, maxLength: 200 } } } } }, async request => {
    const { token } = request.params as { token: string };
    return inviteDetails(pools, token);
  });

  app.post('/v1/auth/invites/accept', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['auth'], body: { type: 'object', required: ['token','password'],
    properties: { token: { type: 'string' }, password: { type: 'string', minLength: 8 }, mfaCode: { type: 'string', minLength: 6, maxLength: 32 } }, additionalProperties: false } } }, async request => {
    const { token, password, mfaCode } = request.body as { token: string; password: string; mfaCode?: string };
    await acceptInvite(pools, token, password, mfaCode, config);
    return { ok: true };
  });
}
