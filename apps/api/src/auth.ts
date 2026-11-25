import argon2 from 'argon2';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import type { ApiConfig } from './config.js';
import type { DbPools, Identity } from './db.js';
import { inTransaction } from './db.js';
import { badRequest, conflict, forbidden, unauthorized } from './errors.js';
import { base32FromHex, decryptSecret, encryptSecret, newToken, newTotpSecret, safeEqualHex, sha256, verifyTotp } from './security.js';

type UserRow = { id: string; email: string; password_hash: string; is_platform_admin: boolean; disabled_at: Date | null };
type MembershipRow = { id: string; role: 'admin' | 'courier'; status: string; tenant_status: string; tenant_id: string; tenant_name: string };
type SessionRow = { id: string; user_id: string; membership_id: string | null; scope: 'platform' | 'tenant'; mfa_verified: boolean; csrf_hash: string | null; expires_at: Date; revoked_at: Date | null; is_platform_admin: boolean; disabled_at: Date | null; role: 'admin' | 'courier' | null; membership_status: string | null; tenant_status: string | null; tenant_id: string | null; tenant_name: string | null };

export async function createSession(pools: DbPools, user: UserRow, membership: MembershipRow | null, scope: 'platform' | 'tenant', client: 'web' | 'mobile') {
  const token = newToken();
  const csrf = client === 'web' ? newToken() : null;
  const mfaRequired = scope === 'platform' || membership?.role === 'admin';
  const expiresAt = new Date(Date.now() + (client === 'web' ? 7 : 30) * 24 * 60 * 60 * 1000);
  await pools.auth.query(`INSERT INTO app.auth_sessions(user_id, membership_id, scope, token_hash, csrf_hash, mfa_verified, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [user.id, membership?.id ?? null, scope, sha256(token), csrf ? sha256(csrf) : null, !mfaRequired, expiresAt]);
  return { token, csrf, mfaRequired, expiresAt };
}

export async function login(pools: DbPools, email: string, password: string, scope: 'platform' | 'tenant', client: 'web' | 'mobile') {
  const result = await pools.auth.query<UserRow>(`SELECT id,email,password_hash,is_platform_admin,disabled_at
    FROM app.users WHERE email = $1`, [email.toLowerCase().trim()]);
  const user = result.rows[0];
  if (!user || user.disabled_at || !(await argon2.verify(user.password_hash, password).catch(() => false))) unauthorized();
  let membership: MembershipRow | null = null;
  if (scope === 'platform') {
    if (!user.is_platform_admin) forbidden();
  } else {
    if (user.is_platform_admin) forbidden();
    const memberResult = await pools.auth.query<MembershipRow>(`SELECT m.id,m.role,m.status,m.tenant_id,
      t.name AS tenant_name,t.status AS tenant_status
      FROM app.tenant_memberships m JOIN app.tenants t ON t.id=m.tenant_id
      WHERE m.user_id=$1 AND m.status='active'`, [user.id]);
    membership = memberResult.rows[0] ?? null;
    if (!membership || membership.tenant_status !== 'active') forbidden();
  }
  const session = await createSession(pools, user, membership, scope, client);
  await pools.auth.query(`INSERT INTO app.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id)
    VALUES ((SELECT tenant_id FROM app.tenant_memberships WHERE id=$1),$2,'auth.login','user',$2)`,
    [membership?.id ?? null,user.id]);
  return { ...session, user: { id: user.id, email: user.email }, scope,
    role: scope === 'platform' ? 'platform' : membership!.role,
    tenant: membership ? { id: membership.tenant_id, name: membership.tenant_name } : null };
}

export async function authenticate(request: FastifyRequest, pools: DbPools, allowPending = false): Promise<{ identity: Identity; session: SessionRow; cookie: boolean }> {
  const bearer = /^Bearer (.+)$/i.exec(request.headers.authorization ?? '')?.[1];
  const cookieToken = request.cookies?.session;
  const token = bearer ?? cookieToken;
  if (!token || token.length > 200) unauthorized();
  const result = await pools.auth.query<SessionRow>(`SELECT s.*,u.is_platform_admin,u.disabled_at,
    m.role,m.status AS membership_status,m.tenant_id,t.name AS tenant_name,t.status AS tenant_status
    FROM app.auth_sessions s JOIN app.users u ON u.id=s.user_id
    LEFT JOIN app.tenant_memberships m ON m.id=s.membership_id
    LEFT JOIN app.tenants t ON t.id=m.tenant_id
    WHERE s.token_hash=$1`, [sha256(token)]);
  const session = result.rows[0];
  if (!session || session.revoked_at || session.expires_at.getTime() <= Date.now() || session.disabled_at) unauthorized();
  if (session.scope === 'platform' && !session.is_platform_admin) unauthorized();
  if (session.scope === 'tenant' && (session.membership_status !== 'active' || session.tenant_status !== 'active')) unauthorized();
  if (!allowPending && !session.mfa_verified) forbidden();
  const cookie = !bearer;
  if (cookie && !['GET','HEAD','OPTIONS'].includes(request.method)) {
    const csrf = request.headers['x-csrf-token'];
    if (!session.csrf_hash || typeof csrf !== 'string' || !safeEqualHex(sha256(csrf), session.csrf_hash)) forbidden();
  }
  return {
    identity: { userId: session.user_id, membershipId: session.membership_id, scope: session.scope,
      role: session.scope === 'platform' ? 'platform' : session.role! },
    session,
    cookie,
  };
}

export function setSessionCookie(reply: FastifyReply, token: string, config: ApiConfig): void {
  reply.setCookie('session', token, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/v1', maxAge: 7 * 24 * 60 * 60 });
}

export async function createInvite(client: PoolClient, input: { email: string; purpose: 'invite' | 'password_reset'; tenantId?: string; role?: 'admin' | 'courier'; actorId: string }) {
  const token = newToken();
  const result = await client.query<{ id: string; expires_at: Date }>(`INSERT INTO app.auth_invites
    (token_hash,purpose,email,tenant_id,tenant_role,created_by_user_id,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,now()+interval '30 minutes') RETURNING id,expires_at`,
    [sha256(token), input.purpose, input.email.toLowerCase().trim(), input.tenantId ?? null, input.role ?? null, input.actorId]);
  return { token, ...result.rows[0]! };
}

export async function inviteDetails(pools: DbPools, token: string): Promise<{ purpose: 'invite' | 'password_reset'; mfaRequired: boolean }> {
  const result = await pools.auth.query<{ purpose: 'invite' | 'password_reset'; mfa_required: boolean }>(`SELECT i.purpose,
    i.purpose='password_reset' AND EXISTS (
      SELECT 1 FROM app.users u JOIN app.totp_factors f ON f.user_id=u.id
      WHERE u.email=i.email AND f.enabled_at IS NOT NULL
    ) AS mfa_required
    FROM app.auth_invites i
    WHERE i.token_hash=$1 AND i.consumed_at IS NULL AND i.expires_at>now()`, [sha256(token)]);
  const invite = result.rows[0];
  if (!invite) badRequest('Convite inválido ou expirado');
  return { purpose: invite.purpose, mfaRequired: invite.mfa_required };
}

async function verifyPasswordResetMfa(client: PoolClient, userId: string, code: string | undefined, config: ApiConfig) {
  const result = await client.query<{ encrypted_secret: string; enabled_at: Date | null; last_used_step: string | null }>(
    'SELECT encrypted_secret,enabled_at,last_used_step FROM app.totp_factors WHERE user_id=$1 FOR UPDATE', [userId]);
  const factor = result.rows[0];
  if (!factor?.enabled_at) return;
  if (!code) unauthorized();
  const secret = decryptSecret(factor.encrypted_secret, config.mfaKey);
  const step = verifyTotp(secret, code, factor.last_used_step ? Number(factor.last_used_step) : null);
  if (step !== null) {
    await client.query('UPDATE app.totp_factors SET last_used_step=$1 WHERE user_id=$2', [step, userId]);
    return;
  }
  const recovery = await client.query(`UPDATE app.mfa_recovery_codes SET used_at=now()
    WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING code_hash`, [userId, sha256(code)]);
  if (!recovery.rowCount) unauthorized();
}

export async function acceptInvite(pools: DbPools, token: string, password: string, mfaCode: string | undefined, config: ApiConfig): Promise<void> {
  if (password.length < 8 || password.length > 256) badRequest('A senha deve ter entre 8 e 256 caracteres');
  await inTransaction(pools.auth, async client => {
    const result = await client.query<{ id: string; email: string; purpose: string; tenant_id: string | null; tenant_role: string | null }>(
      `SELECT id,email,purpose,tenant_id,tenant_role FROM app.auth_invites
       WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`, [sha256(token)]);
    const invite = result.rows[0];
    if (!invite) badRequest('Convite inválido ou expirado');
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const existing = await client.query<{ id: string; is_platform_admin: boolean }>(
      'SELECT id,is_platform_admin FROM app.users WHERE email=$1', [invite.email]);
    let userId = existing.rows[0]?.id;
    if (invite.purpose === 'password_reset') {
      if (!userId) badRequest('Conta não encontrada');
      await verifyPasswordResetMfa(client, userId, mfaCode, config);
      await client.query('UPDATE app.users SET password_hash=$1,updated_at=now() WHERE id=$2', [hash, userId]);
      await client.query('UPDATE app.auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
    } else {
      if (existing.rows[0]?.is_platform_admin) forbidden();
      if (!userId) {
        const inserted = await client.query<{ id: string }>(`INSERT INTO app.users(email,password_hash,full_name)
          VALUES ($1,$2,$3) RETURNING id`, [invite.email, hash, invite.email.split('@')[0]]);
        userId = inserted.rows[0]!.id;
      }
      const active = await client.query('SELECT 1 FROM app.tenant_memberships WHERE user_id=$1 AND status=$2', [userId, 'active']);
      if (active.rowCount) conflict('Usuário já possui vínculo empresarial ativo');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [invite.tenant_id]);
      const counts = await client.query<{ users: string; couriers: string }>(`SELECT count(*)::text AS users,
        count(*) FILTER (WHERE role='courier')::text AS couriers
        FROM app.tenant_memberships WHERE tenant_id=$1 AND status='active'`, [invite.tenant_id]);
      const limits = await client.query<{ max_users: number | null; max_couriers: number | null }>(`SELECT p.max_users,p.max_couriers
        FROM app.subscriptions s JOIN app.plans p ON p.id=s.plan_id
        WHERE s.tenant_id=$1 AND s.ended_at IS NULL AND s.status='active' AND p.active`, [invite.tenant_id]);
      const usage = counts.rows[0]!;
      const limit = limits.rows[0];
      if (!limit && Number(usage.users) > 0) forbidden();
      if (limit?.max_users !== null && limit?.max_users !== undefined && Number(usage.users) >= limit.max_users)
        conflict('Limite de usuários atingido');
      if (invite.tenant_role === 'courier' && limit?.max_couriers !== null && limit?.max_couriers !== undefined &&
        Number(usage.couriers) >= limit.max_couriers) conflict('Limite de entregadores atingido');
      await client.query(`INSERT INTO app.tenant_memberships(tenant_id,user_id,role)
        VALUES ($1,$2,$3)`, [invite.tenant_id, userId, invite.tenant_role]);
    }
    await client.query('UPDATE app.auth_invites SET consumed_at=now() WHERE id=$1', [invite.id]);
    await client.query(`INSERT INTO app.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id)
      VALUES ($1,$2,$3,'user',$2)`, [invite.tenant_id,userId,
        invite.purpose === 'invite' ? 'auth.invite_accepted' : 'auth.password_reset']);
  });
}

export async function startMfa(pools: DbPools, session: SessionRow, config: ApiConfig) {
  const existing = await pools.auth.query<{ enabled_at: Date | null }>('SELECT enabled_at FROM app.totp_factors WHERE user_id=$1', [session.user_id]);
  if (existing.rows[0]?.enabled_at) conflict('MFA já está ativo');
  const secret = newTotpSecret();
  await pools.auth.query(`INSERT INTO app.totp_factors(user_id,encrypted_secret) VALUES ($1,$2)
    ON CONFLICT (user_id) DO UPDATE SET encrypted_secret=EXCLUDED.encrypted_secret`, [session.user_id, encryptSecret(secret, config.mfaKey)]);
  return { secret: base32FromHex(secret), otpauth: `otpauth://totp/Entregas:${session.user_id}?secret=${base32FromHex(secret)}&issuer=Entregas` };
}

export async function verifyMfa(pools: DbPools, session: SessionRow, code: string, config: ApiConfig) {
  return inTransaction(pools.auth, async client => {
    const factorResult = await client.query<{ encrypted_secret: string; enabled_at: Date | null; last_used_step: string | null }>(
      'SELECT encrypted_secret,enabled_at,last_used_step FROM app.totp_factors WHERE user_id=$1 FOR UPDATE', [session.user_id]);
    const factor = factorResult.rows[0];
    if (!factor) badRequest('MFA não configurado');
    const secret = decryptSecret(factor.encrypted_secret, config.mfaKey);
    const step = verifyTotp(secret, code, factor.last_used_step ? Number(factor.last_used_step) : null);
    let recovery = false;
    if (step === null) {
      const used = await client.query(`UPDATE app.mfa_recovery_codes SET used_at=now()
        WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING code_hash`, [session.user_id, sha256(code)]);
      if (!used.rowCount) unauthorized();
      recovery = true;
    } else {
      await client.query(`UPDATE app.totp_factors SET last_used_step=$1,enabled_at=coalesce(enabled_at,now()) WHERE user_id=$2`, [step, session.user_id]);
    }
    if (!factor.enabled_at && recovery) unauthorized();
    let recoveryCodes: string[] | undefined;
    if (!factor.enabled_at) {
      recoveryCodes = Array.from({ length: 8 }, () => newToken().slice(0, 16));
      for (const item of recoveryCodes) await client.query('INSERT INTO app.mfa_recovery_codes(user_id,code_hash) VALUES ($1,$2)', [session.user_id, sha256(item)]);
      await client.query('UPDATE app.users SET mfa_enabled=true WHERE id=$1', [session.user_id]);
    }
    await client.query('UPDATE app.auth_sessions SET mfa_verified=true WHERE id=$1', [session.id]);
    await client.query(`INSERT INTO app.audit_logs(actor_user_id,action,entity_type,entity_id)
      VALUES ($1,$2,'user',$1)`, [session.user_id,factor.enabled_at ? 'auth.mfa_verified' : 'auth.mfa_enrolled']);
    return { verified: true, recoveryCodes };
  });
}
