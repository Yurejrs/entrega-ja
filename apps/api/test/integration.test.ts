import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile, utimes, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import sharp from 'sharp';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { decryptSecret, sha256, totpCode } from '../src/security.js';
import { createNotificationWorker } from '../src/worker-core.js';

type Session = { cookie?: string; csrf?: string; token?: string; recoveryCodes?: string[] };

function headers(session?: Session): Record<string,string> {
  if (!session) return {};
  if (session.token) return { authorization: `Bearer ${session.token}` };
  return { cookie: session.cookie!, 'x-csrf-token': session.csrf! };
}

async function call(app: FastifyInstance, method: string, url: string, body?: unknown, session?: Session) {
  const response = await app.inject({ method, url, headers: body === undefined ? headers(session) : { ...headers(session), 'content-type': 'application/json' },
    payload: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.statusCode, data: response.json(), response };
}

async function loginAndMfa(app: FastifyInstance, pools: Awaited<ReturnType<typeof buildServer>>['pools'], config: ApiConfig,
  email: string, password: string, scope: 'platform' | 'tenant'): Promise<Session> {
  const login = await call(app,'POST','/v1/auth/login',{ email,password,scope,client:'web' });
  assert.equal(login.status,200,JSON.stringify(login.data));
  const session = { cookie: login.response.headers['set-cookie']!.toString().split(';')[0]!, csrf: login.data.csrfToken as string };
  const setup = await call(app,'POST','/v1/auth/mfa/setup',{},session);
  assert.equal(setup.status,200,JSON.stringify(setup.data));
  const user = await pools.auth.query<{ id: string }>('SELECT id FROM app.users WHERE email=$1',[email]);
  const factor = await pools.auth.query<{ encrypted_secret: string }>('SELECT encrypted_secret FROM app.totp_factors WHERE user_id=$1',[user.rows[0]!.id]);
  const code = totpCode(decryptSecret(factor.rows[0]!.encrypted_secret,config.mfaKey),Math.floor(Date.now()/30000));
  const verified = await call(app,'POST','/v1/auth/mfa/verify',{code},session);
  assert.equal(verified.status,200,JSON.stringify(verified.data));
  return { ...session, recoveryCodes: verified.data.recoveryCodes as string[] | undefined };
}

test('full API flow with real PostgreSQL roles', async () => {
  const dir = await mkdtemp(join(tmpdir(),'entregas-api-'));
  const port = process.env.TEST_DB_PORT ?? '55433';
  const database = process.env.TEST_DB_NAME ?? 'entregas_api_test';
  const url = (name: string, password: string) => `postgres://${name}:${password}@127.0.0.1:${port}/${database}`;
  const config: ApiConfig = {
    host: '127.0.0.1',port:0,
    authDatabaseUrl:url('api_auth','local-auth-only'),tenantDatabaseUrl:url('api_tenant','local-tenant-only'),
    platformDatabaseUrl:url('api_platform','local-platform-only'),workerDatabaseUrl:url('api_worker','local-worker-only'),
    fileStorageDir:dir,mfaKey:Buffer.alloc(32,1),cookieSecure:false,checkInMaxDistanceM:200,
    gpsMaxFutureSkewSeconds:300,gpsMaxAgeDays:30,gpsLowPrecisionThresholdM:200,locationPolicyVersion:'1.0.0',
  };
  const { app,pools } = await buildServer(config);
  try {
    await app.ready();
    const openapi = app.swagger();
    assert.equal(openapi.info?.version, '1.0.0');
    assert.ok(openapi.paths?.['/auth/login']);
    assert.ok(openapi.paths?.['/deliveries']);
    assert.ok(openapi.paths?.['/mobile/location-consent']);
    assert.ok(openapi.paths?.['/mobile/location-sharing']);
    assert.ok(openapi.paths?.['/mobile/location-sharing/locations']);
    assert.ok(openapi.paths?.['/mobile/routes/{id}/locations']);
    assert.ok(openapi.paths?.['/mobile/routes/{id}/cancel']);
    assert.ok(openapi.paths?.['/tenant/customers']);
    assert.ok(openapi.paths?.['/tenant/routes/{id}/live']);
    assert.ok(openapi.paths?.['/tenant/live-locations/stream']);
    const platformEmail = `platform-${randomUUID()}@test.local`;
    const password = 'test-123';
    await pools.auth.query(`INSERT INTO app.users(email,password_hash,full_name,is_platform_admin)
      VALUES ($1,$2,'Platform Test',true)`,[platformEmail,await argon2.hash(password)]);
    const platform = await loginAndMfa(app,pools,config,platformEmail,password,'platform');

    const plan = await call(app,'POST','/v1/platform/plans',{name:`Plan ${randomUUID()}`,maxMonthlyDeliveries:100},platform);
    assert.equal(plan.status,201,JSON.stringify(plan.data));
    const restoredCsrf = await call(app,'GET','/v1/auth/csrf',undefined,platform);
    assert.equal(restoredCsrf.status,200,JSON.stringify(restoredCsrf.data));
    assert.notEqual(restoredCsrf.data.csrfToken,platform.csrf);
    assert.equal((await call(app,'PATCH',`/v1/platform/plans/${plan.data.id}`,{name:'Old CSRF rejected'},platform)).status,403);
    platform.csrf = restoredCsrf.data.csrfToken;
    assert.equal((await call(app,'PATCH',`/v1/platform/plans/${plan.data.id}`,{name:`Restored session ${randomUUID()}`},platform)).status,200);
    const adminEmail = `admin-${randomUUID()}@test.local`;
    const tenantName = `Integration Tenant ${randomUUID()}`;
    const tenant = await call(app,'POST','/v1/platform/tenants',{name:tenantName,adminEmail},platform);
    assert.equal(tenant.status,201,JSON.stringify(tenant.data));
    const tenantId = tenant.data.id as string;
    const searchedTenants = await call(app,'GET',`/v1/platform/tenants?search=${encodeURIComponent(tenantName)}`,undefined,platform);
    assert.ok(searchedTenants.data.items.some((row: {id:string}) => row.id===tenantId));
    const inviteAccepted = await call(app,'POST','/v1/auth/invites/accept',{token:tenant.data.adminInvite.token,password});
    assert.equal(inviteAccepted.status,200,JSON.stringify(inviteAccepted.data));
    const subscription = await call(app,'POST','/v1/platform/subscriptions',{tenantId,planId:plan.data.id},platform);
    assert.equal(subscription.status,201,JSON.stringify(subscription.data));
    const admin = await loginAndMfa(app,pools,config,adminEmail,password,'tenant');
    const platformInvite = await call(app,'POST','/v1/tenant/invites',{email:platformEmail,role:'admin'},admin);
    assert.equal(platformInvite.status,201);
    assert.equal((await call(app,'POST','/v1/auth/invites/accept',
      {token:platformInvite.data.token,password})).status,403);

    const customer = await call(app,'POST','/v1/tenant/customers',{name:'Maria',phone:'85999999999'},admin);
    assert.equal(customer.status,201,JSON.stringify(customer.data));
    const searchedCustomers = await call(app,'GET','/v1/tenant/customers?search=Maria',undefined,admin);
    assert.ok(searchedCustomers.data.items.some((row: {id:string}) => row.id===customer.data.id));
    const address = await call(app,'POST','/v1/tenant/addresses',{customerId:customer.data.id,street:'Rua Um',city:'Fortaleza',state:'CE',referenceLatitude:-3.7319,referenceLongitude:-38.5267},admin);
    assert.equal(address.status,201,JSON.stringify(address.data));
    const searchedAddresses = await call(app,'GET','/v1/tenant/addresses?search=Rua%20Um',undefined,admin);
    assert.ok(searchedAddresses.data.items.some((row: {id:string}) => row.id===address.data.id));
    const courierEmail = `courier-${randomUUID()}@test.local`;
    const courierInvite = await call(app,'POST','/v1/tenant/invites',{email:courierEmail,role:'courier'},admin);
    assert.equal(courierInvite.status,201,JSON.stringify(courierInvite.data));
    assert.equal((await call(app,'POST','/v1/auth/invites/accept',{token:courierInvite.data.token,password:'short7'})).status,400);
    const accepted = await call(app,'POST','/v1/auth/invites/accept',{token:courierInvite.data.token,password});
    assert.equal(accepted.status,200,JSON.stringify(accepted.data));
    const courierLogin = await call(app,'POST','/v1/auth/login',{email:courierEmail,password,scope:'tenant',client:'mobile'});
    assert.equal(courierLogin.status,200,JSON.stringify(courierLogin.data));
    assert.equal(courierLogin.data.tenant.id,tenantId);
    const courier: Session = { token:courierLogin.data.token };
    const courierMe = await call(app,'GET','/v1/auth/me',undefined,courier);
    const courierMembershipId = courierMe.data.membershipId as string;
    const searchedUsers = await call(app,'GET',`/v1/tenant/users?search=${encodeURIComponent(courierEmail)}`,undefined,admin);
    assert.equal(searchedUsers.status,200,JSON.stringify(searchedUsers.data));
    assert.ok(searchedUsers.data.items.some((row: {membership_id:string}) => row.membership_id===courierMembershipId));
    assert.equal((await call(app,'PATCH','/v1/tenant/settings',{contactEmail:'contato@empresa.test'},admin)).status,200);
    assert.equal((await call(app,'GET','/v1/tenant/settings',undefined,admin)).data.contact_email,'contato@empresa.test');
    const renamed = await call(app,'PATCH',`/v1/tenant/users/${courierMembershipId}/profile`,
      {fullName:'Entregador Atualizado'},admin);
    assert.equal(renamed.status,200,JSON.stringify(renamed.data));
    assert.equal(renamed.data.full_name,'Entregador Atualizado');
    const device = await call(app,'PUT',`/v1/mobile/devices/${randomUUID()}`,{fcmToken:`fcm-${randomUUID()}`},courier);
    assert.equal(device.status,200,JSON.stringify(device.data));
    const courierProfile = await call(app,'GET','/v1/mobile/profile',undefined,courier);
    assert.equal(courierProfile.status,200,JSON.stringify(courierProfile.data));
    assert.equal(courierProfile.data.has_photo,false);
    assert.equal(courierProfile.data.has_cover,false);
    const profileBoundary = 'profile-photo-boundary';
    const profilePhoto = await sharp({create:{width:3,height:3,channels:3,background:'#0f4c5c'}}).jpeg().toBuffer();
    const profileMultipart = Buffer.concat([
      Buffer.from(`--${profileBoundary}\r\nContent-Disposition: form-data; name="photo"; filename="profile.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      profilePhoto,Buffer.from(`\r\n--${profileBoundary}--\r\n`),
    ]);
    const profileUpload = await app.inject({method:'PUT',url:'/v1/mobile/profile/photo',
      headers:{...headers(courier),'content-type':`multipart/form-data; boundary=${profileBoundary}`},payload:profileMultipart});
    assert.equal(profileUpload.statusCode,200,profileUpload.body);
    assert.equal(profileUpload.json().has_photo,true);
    const profileImage = await app.inject({method:'GET',url:'/v1/mobile/profile/photo',headers:headers(courier)});
    assert.equal(profileImage.statusCode,200,profileImage.body);
    assert.equal(profileImage.headers['content-type'],'image/jpeg');
    const coverUpload = await app.inject({method:'PUT',url:'/v1/mobile/profile/cover',
      headers:{...headers(courier),'content-type':`multipart/form-data; boundary=${profileBoundary}`},payload:profileMultipart});
    assert.equal(coverUpload.statusCode,200,coverUpload.body);
    assert.equal(coverUpload.json().has_cover,true);
    const profileCover = await app.inject({method:'GET',url:'/v1/mobile/profile/cover',headers:headers(courier)});
    assert.equal(profileCover.statusCode,200,profileCover.body);
    assert.equal(profileCover.headers['content-type'],'image/jpeg');
    const savedCourierProfile = await call(app,'PATCH','/v1/mobile/profile',{location:'Fortaleza, CE'},courier);
    assert.equal(savedCourierProfile.status,200,JSON.stringify(savedCourierProfile.data));
    assert.equal(savedCourierProfile.data.profile_location,'Fortaleza, CE');
    const configuredBadge = await call(app,'POST','/v1/tenant/gamification/badges',
      {name:'Bom começo',description:'Alcance cinco entregas concluídas',target:5},admin);
    assert.equal(configuredBadge.status,200,JSON.stringify(configuredBadge.data));
    const gamification = await call(app,'GET','/v1/tenant/gamification',undefined,admin);
    assert.equal(gamification.status,200,JSON.stringify(gamification.data));
    assert.deepEqual(gamification.data.overview.summary,{today:0,week:0,month:0,activeCouriers:1});
    assert.equal(gamification.data.overview.leaderboard[0].membershipId,courierMembershipId);
    assert.equal(gamification.data.overview.leaderboard[0].weekCompleted,0);
    assert.equal(gamification.data.overview.badgeProgress[0].name,'Bom começo');
    assert.equal(gamification.data.overview.activeChallenge,null);
    const absentReason = gamification.data.reasons.find((reason: { code: string }) => reason.code === 'customer_absent');
    assert.ok(absentReason?.id);
    assert.equal((await call(app,'PATCH',`/v1/tenant/gamification/problem-reasons/${absentReason.id}`,{active:false},admin)).status,200);
    const productivity = await call(app,'GET','/v1/mobile/productivity?period=week',undefined,courier);
    assert.equal(productivity.status,200,JSON.stringify(productivity.data));
    assert.equal(productivity.data.period,'week');
    assert.equal(productivity.data.items.length,7);
    assert.equal(typeof productivity.data.lifetime,'number');
    assert.ok(!productivity.data.problemReasons.some((reason: { code: string }) => reason.code === 'customer_absent'));
    assert.equal((await call(app,'PATCH',`/v1/tenant/gamification/problem-reasons/${absentReason.id}`,{active:true},admin)).status,200);
    assert.equal(productivity.data.badges[0].id,configuredBadge.data.id);
    assert.equal(productivity.data.badges[0].progress,0);
    assert.equal(productivity.data.leaderboard.length,1);
    assert.equal(productivity.data.leaderboard[0].membershipId,courierMembershipId);
    assert.equal(productivity.data.leaderboard[0].hasPhoto,true);
    const leaderboardPhoto=await app.inject({method:'GET',url:`/v1/mobile/leaderboard/${courierMembershipId}/photo`,headers:headers(courier)});
    assert.equal(leaderboardPhoto.statusCode,200,leaderboardPhoto.body);
    assert.equal(leaderboardPhoto.headers['content-type'],'image/jpeg');
    assert.equal((await app.inject({method:'GET',url:`/v1/mobile/leaderboard/${courierMembershipId}/photo`,headers:headers(admin)})).statusCode,403);
    assert.equal((await call(app,'GET','/v1/mobile/profile',undefined,admin)).status,403);

    const createBody = {customerId:customer.data.id,addressId:address.data.id,courierMembershipId,
      merchandiseDescription:'Pacote de teste',estimatedEarningsCents:1250};
    const invalid = await call(app,'POST','/v1/deliveries',{...createBody,courierMembershipId:randomUUID()},admin);
    assert.equal(invalid.status,400,JSON.stringify(invalid.data));
    const created = await call(app,'POST','/v1/deliveries',createBody,admin);
    assert.equal(created.status,201,JSON.stringify(created.data));
    const deliveryId = created.data.id as string;
    const createdDetails = await call(app,'GET',`/v1/deliveries/${deliveryId}`,undefined,admin);
    assert.equal(createdDetails.data.estimated_earnings_cents,1250);
    const searchedDeliveries = await call(app,'GET','/v1/deliveries?search=Pacote%20de%20teste&status=assigned',undefined,admin);
    assert.ok(searchedDeliveries.data.items.some((row: {id:string;customer_name:string}) => row.id===deliveryId && row.customer_name==='Maria'));
    const todayFortaleza = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Fortaleza'}).format(new Date());
    const overdue = await call(app,'POST','/v1/deliveries',{...createBody,merchandiseDescription:'Entrega atrasada',scheduledFor:'2020-01-01T12:00:00-03:00'},admin);
    const dueToday = await call(app,'POST','/v1/deliveries',{...createBody,merchandiseDescription:'Entrega de hoje',scheduledFor:`${todayFortaleza}T12:00:00-03:00`},admin);
    const dueTomorrow = new Date(`${todayFortaleza}T12:00:00-03:00`);
    dueTomorrow.setDate(dueTomorrow.getDate()+1);
    const future = await call(app,'POST','/v1/deliveries',{...createBody,merchandiseDescription:'Entrega futura',scheduledFor:dueTomorrow.toISOString()},admin);
    for (const createdExtra of [overdue,dueToday,future]) assert.equal(createdExtra.status,201,JSON.stringify(createdExtra.data));
    const route = await call(app,'POST','/v1/mobile/routes',{deliveryIds:[deliveryId,dueToday.data.id,future.data.id]},courier);
    assert.equal(route.status,200,JSON.stringify(route.data));
    const blockedStart = await call(app,'POST',`/v1/mobile/routes/${route.data.id}/start`,{},courier);
    assert.equal(blockedStart.status,400,JSON.stringify(blockedStart.data));
    const locationConsent = await call(app,'POST','/v1/mobile/location-consent',{policyVersion:'1.0.0'},courier);
    assert.equal(locationConsent.status,200,JSON.stringify(locationConsent.data));
    const sharingBefore = await call(app,'GET','/v1/mobile/location-sharing',undefined,courier);
    assert.equal(sharingBefore.data.enabled,false);
    let shiftId=randomUUID();
    const sharingEnabled = await call(app,'PUT','/v1/mobile/location-sharing',{enabled:true,shiftId},courier);
    assert.equal(sharingEnabled.status,200,JSON.stringify(sharingEnabled.data));
    const livePoint = {clientPointId:randomUUID(),latitude:-3.7321,longitude:-38.5269,accuracyM:12,capturedAt:new Date().toISOString()};
    const liveLocation = await call(app,'POST','/v1/mobile/location-sharing/locations',{shiftId,points:[livePoint]},courier);
    assert.equal(liveLocation.status,200,JSON.stringify(liveLocation.data));
    assert.equal(liveLocation.data.accepted,1);
    const sharingDashboard = await call(app,'GET','/v1/tenant/dashboard?period=day',undefined,admin);
    assert.ok(sharingDashboard.data.liveCouriers.some((row:{sharing_id:string;latitude:number}) => row.sharing_id===courierMembershipId && Number(row.latitude)===livePoint.latitude));
    const sharingDisabled = await call(app,'PUT','/v1/mobile/location-sharing',{enabled:false,shiftId},courier);
    assert.equal(sharingDisabled.data.enabled,false);
    const startedRoute = await call(app,'POST',`/v1/mobile/routes/${route.data.id}/start`,{},courier);
    assert.equal(startedRoute.status,200,JSON.stringify(startedRoute.data));
    const courierRouteStatus = await call(app,'GET',`/v1/mobile/routes/${route.data.id}`,undefined,courier);
    assert.equal(courierRouteStatus.data.status,'active');
    const overview = await call(app,'GET',`/v1/mobile/routes/${route.data.id}?include=stops`,undefined,courier);
    assert.deepEqual(overview.data.stops.map((stop:{id:string})=>stop.id),[deliveryId,dueToday.data.id,future.data.id]);
    assert.equal(overview.data.stops[0].customer,'Maria');
    assert.equal(overview.data.stops[0].checked,false);
    const offDuty=await call(app,'POST',`/v1/mobile/routes/${route.data.id}/locations`,{shiftId,points:[livePoint]},courier);
    assert.equal(offDuty.status,409);
    assert.equal((await call(app,'POST','/v1/mobile/location-sharing/locations',{shiftId,points:[livePoint]},courier)).status,409);
    shiftId=randomUUID();
    assert.equal((await call(app,'PUT','/v1/mobile/location-sharing',{enabled:true,shiftId},courier)).status,200);
    assert.equal((await call(app,'POST','/v1/mobile/location-sharing/locations',{shiftId,points:[{...livePoint,capturedAt:new Date(Date.now()-60000).toISOString()}]},courier)).status,400);
    const routePoint = {clientPointId:randomUUID(),latitude:-3.7319,longitude:-38.5267,accuracyM:8,capturedAt:new Date().toISOString()};
    const routeLocation = await call(app,'POST',`/v1/mobile/routes/${route.data.id}/locations`,{shiftId,points:[routePoint]},courier);
    assert.equal(routeLocation.status,200,JSON.stringify(routeLocation.data));
    assert.equal(routeLocation.data.accepted,1);
    const routeLocationReplay = await call(app,'POST',`/v1/mobile/routes/${route.data.id}/locations`,{shiftId,points:[routePoint]},courier);
    assert.equal(routeLocationReplay.status,200,JSON.stringify(routeLocationReplay.data));
    assert.equal(routeLocationReplay.data.accepted,0);
    const expiredRoutePointId=randomUUID();
    const expiredRoutePoint={...routePoint,clientPointId:expiredRoutePointId,capturedAt:new Date(Date.now()-31*24*60*60*1000).toISOString()};
    const oldRouteLocation=await call(app,'POST',`/v1/mobile/routes/${route.data.id}/locations`,{shiftId,points:[expiredRoutePoint]},courier);
    assert.equal(oldRouteLocation.status,400,JSON.stringify(oldRouteLocation.data));
    const futureRoutePoint={...routePoint,clientPointId:randomUUID(),capturedAt:new Date(Date.now()+6*60*1000).toISOString()};
    const futureRouteLocation=await call(app,'POST',`/v1/mobile/routes/${route.data.id}/locations`,{shiftId,points:[futureRoutePoint]},courier);
    assert.equal(futureRouteLocation.status,400,JSON.stringify(futureRouteLocation.data));
    const impreciseRoutePoint={...routePoint,clientPointId:randomUUID(),accuracyM:250};
    const impreciseRouteLocation=await call(app,'POST',`/v1/mobile/routes/${route.data.id}/locations`,{shiftId,points:[impreciseRoutePoint]},courier);
    assert.equal(impreciseRouteLocation.status,200,JSON.stringify(impreciseRouteLocation.data));
    assert.equal(impreciseRouteLocation.data.lowPrecision,1);
    const liveRoute = await call(app,'GET',`/v1/tenant/routes/${route.data.id}/live`,undefined,admin);
    assert.equal(liveRoute.status,200,JSON.stringify(liveRoute.data));
    assert.equal(liveRoute.data.route.status,'active');
    assert.equal(liveRoute.data.stops.length,3);
    assert.equal(liveRoute.data.points.length,1,'the live map excludes points older than 30 days');
    assert.equal((await call(app,'GET',`/v1/tenant/routes/${route.data.id}/live`,undefined,courier)).status,403);
    const openToday = await call(app,'GET',`/v1/deliveries?tab=open&day=${todayFortaleza}`,undefined,admin);
    const openTodayIds = openToday.data.items.map((row:{id:string})=>row.id);
    assert.ok(openTodayIds.includes(deliveryId),'unscheduled work created today appears in today open tab');
    assert.ok(openTodayIds.includes(overdue.data.id),'overdue work appears in today open tab');
    assert.ok(openTodayIds.includes(dueToday.data.id),'work due today appears in today open tab');
    assert.ok(!openTodayIds.includes(future.data.id),'future work stays out of today open tab');
    const dashboardMonth = await call(app,'GET','/v1/tenant/dashboard?period=month',undefined,admin);
    assert.equal(dashboardMonth.status,200,JSON.stringify(dashboardMonth.data));
    assert.ok(dashboardMonth.data.summary.month>=4);
    assert.ok(dashboardMonth.data.series.items.length>=28 && dashboardMonth.data.series.items.length<=31);
    const dashboardWeek = await call(app,'GET','/v1/tenant/dashboard?period=week',undefined,admin);
    assert.equal(dashboardWeek.data.series.items.length,7);
    const dashboardDay = await call(app,'GET','/v1/tenant/dashboard?period=day',undefined,admin);
    assert.equal(dashboardDay.data.series.items.length,24);
    const op = randomUUID();
    const checkInBody = {clientOperationId:op,latitude:-3.7319,longitude:-38.5267,accuracyM:10,occurredAt:new Date().toISOString()};
    const checkIn = await call(app,'POST',`/v1/deliveries/${deliveryId}/check-ins`,checkInBody,courier);
    assert.equal(checkIn.status,200,JSON.stringify(checkIn.data));
    const checkedRoute = await call(app,'GET',`/v1/mobile/routes/${route.data.id}?include=stops`,undefined,courier);
    assert.equal(checkedRoute.data.stops[0].checked,true);
    const syncAfterCheckIn = await call(app,'GET','/v1/mobile/sync',undefined,courier);
    const syncedCheckIn = syncAfterCheckIn.data.items.find((item: {id:string}) => item.id===deliveryId);
    assert.equal(Number(syncedCheckIn.last_check_in_latitude),checkInBody.latitude);
    assert.equal(Number(syncedCheckIn.last_check_in_longitude),checkInBody.longitude);
    const replay = await call(app,'POST',`/v1/deliveries/${deliveryId}/check-ins`,checkInBody,courier);
    assert.equal(replay.status,200,JSON.stringify(replay.data));
    assert.equal(replay.data.replayed,true);
    const changed = await call(app,'POST',`/v1/deliveries/${deliveryId}/check-ins`,{...checkInBody,accuracyM:20},courier);
    assert.equal(changed.status,409,JSON.stringify(changed.data));

    const boundary = 'test-boundary';
    const photo = await sharp({create:{width:2,height:2,channels:3,background:'#ff0000'}}).jpeg().toBuffer();
    const completionOp = randomUUID();
    const occurredAt = new Date().toISOString();
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="clientOperationId"\r\n\r\n${completionOp}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="occurredAt"\r\n\r\n${occurredAt}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="proof.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      photo,Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploadHeaders={...headers(courier),'content-type':`multipart/form-data; boundary=${boundary}`};
    const facadePath=`/v1/deliveries/${deliveryId}/facade`;
    const facade=await call(app,'GET',facadePath,undefined,courier);
    assert.equal(facade.data.capture,true,JSON.stringify(facade.data));
    const facadePayload=Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="revision"\r\n\r\n${facade.data.revision}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="home.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      photo,Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const captured=await app.inject({method:'PUT',url:facadePath,headers:uploadHeaders,payload:facadePayload});
    assert.equal(captured.statusCode,200,captured.body);
    const repeatedFacade=await app.inject({method:'PUT',url:facadePath,headers:uploadHeaders,payload:facadePayload});
    assert.equal(repeatedFacade.statusCode,200,repeatedFacade.body);
    const laterFacade=()=>call(app,'GET',`/v1/deliveries/${future.data.id}/facade`,undefined,courier);
    assert.equal((await laterFacade()).data.capture,false);
    assert.match((await laterFacade()).data.image,/^data:image\/jpeg/);
    const manageFacade=(action:string)=>call(app,'PATCH',`/v1/tenant/addresses/${address.data.id}/facade`,{action},admin);
    assert.equal((await manageFacade('request')).status,200);
    assert.equal((await laterFacade()).data.capture,true);
    assert.ok((await laterFacade()).data.image);
    assert.equal((await manageFacade('remove')).status,200);
    assert.equal((await laterFacade()).data.image,null);
    assert.equal((await laterFacade()).data.capture,true);
    const reuseProof=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="clientOperationId"\r\n\r\n${randomUUID()}\r\n--${boundary}\r\nContent-Disposition: form-data; name="occurredAt"\r\n\r\n${occurredAt}\r\n--${boundary}--\r\n`);
    const finish=()=>app.inject({method:'POST',url:`/v1/deliveries/${deliveryId}/completion`,headers:uploadHeaders,payload:reuseProof});
    assert.equal((await finish()).statusCode,409);
    const proof=await app.inject({method:'POST',url:`/v1/deliveries/${deliveryId}/photos`,headers:uploadHeaders,payload:multipart});
    assert.equal(proof.statusCode,200,proof.body);
    const completion = await finish();
    assert.equal(completion.statusCode,200,completion.body);
    const progressedRoute = await call(app,'GET',`/v1/mobile/routes/${route.data.id}?include=stops`,undefined,courier);
    assert.deepEqual(progressedRoute.data.stops.map((stop:{status:string})=>stop.status),['completed','active','pending']);
    const advancedRoute = await call(app,'GET',`/v1/tenant/routes/${route.data.id}/live`,undefined,admin);
    assert.equal(advancedRoute.data.route.status,'active');
    assert.equal(advancedRoute.data.stops.find((stop:{delivery_id:string})=>stop.delivery_id===deliveryId).status,'completed');
    assert.equal(advancedRoute.data.stops.find((stop:{delivery_id:string})=>stop.delivery_id===dueToday.data.id).status,'active');
    const finishedToday = await call(app,'GET',`/v1/deliveries?tab=finished&day=${todayFortaleza}`,undefined,admin);
    assert.ok(finishedToday.data.items.some((row:{id:string})=>row.id===deliveryId));
    const stillOpenToday = await call(app,'GET',`/v1/deliveries?tab=open&day=${todayFortaleza}`,undefined,admin);
    assert.ok(!stillOpenToday.data.items.some((row:{id:string})=>row.id===deliveryId));
    const completionReplay = await finish();
    assert.equal(completionReplay.statusCode,200,completionReplay.body);
    assert.equal(completionReplay.json().replayed,true);
    const detail = await call(app,'GET',`/v1/deliveries/${deliveryId}`,undefined,admin);
    assert.equal(detail.status,200,JSON.stringify(detail.data));
    assert.equal(detail.data.status,'completed');
    assert.equal(detail.data.photos.length,1);
    const seasonal=await call(app,'GET','/v1/mobile/productivity?period=week',undefined,courier);
    assert.equal(seasonal.status,200,JSON.stringify(seasonal.data));
    assert.equal(seasonal.data.seasonalAwards.week.awarded,true);
    assert.equal(seasonal.data.seasonalAwards.week.rank,1);
    assert.ok(seasonal.data.seasonalAwards.week.completed>=1);
    assert.equal(seasonal.data.seasonalAwards.month.awarded,true);
    assert.ok(new Date(seasonal.data.seasonalAwards.week.resetAt).getTime()>Date.now());
    assert.ok(new Date(seasonal.data.seasonalAwards.month.resetAt).getTime()>Date.now());
    const courierRanking=seasonal.data.leaderboard.find((row:{membershipId:string})=>row.membershipId===courierMembershipId);
    assert.equal(courierRanking.weekWinner,true);
    assert.equal(courierRanking.monthWinner,true);
    const courierPhotos = await call(app,'GET',`/v1/deliveries/${deliveryId}/photos?limit=50`,undefined,courier);
    assert.equal(courierPhotos.status,200,JSON.stringify(courierPhotos.data));
    assert.equal(courierPhotos.data.items.length,1);
    assert.equal(courierPhotos.data.items[0].id,detail.data.photos[0].id);
    const courierDownload = await app.inject({method:'GET',url:`/v1/delivery-photos/${detail.data.photos[0].id}`,headers:headers(courier)});
    assert.equal(courierDownload.statusCode,200,courierDownload.body);
    assert.equal((await sharp(courierDownload.rawPayload).metadata()).format,'jpeg');
    const download = await app.inject({method:'GET',url:`/v1/delivery-photos/${detail.data.photos[0].id}`,headers:headers(admin)});
    assert.equal(download.statusCode,200,download.body);
    assert.equal((await sharp(download.rawPayload).metadata()).format,'jpeg');
    const usageItems: {tenant_id:string;tenant_name:string}[]=[];
    let usageCursor:string|null=null;
    const usageCursors=new Set<string>();
    do {
      const query=new URLSearchParams({limit:'100'});
      if(usageCursor)query.set('cursor',usageCursor);
      const usage=await call(app,'GET',`/v1/platform/usage?${query}`,undefined,platform);
      assert.equal(usage.status,200,JSON.stringify(usage.data));
      usageItems.push(...usage.data.items);
      usageCursor=usage.data.items.length===100?usage.data.nextCursor:null;
      if(usageCursor){assert.ok(!usageCursors.has(usageCursor),'uso SaaS repetiu cursor');usageCursors.add(usageCursor);}
    } while(usageCursor);
    assert.ok(usageItems.some(item=>item.tenant_id===tenantId));
    assert.ok(usageItems.some(item=>item.tenant_id===tenantId && item.tenant_name===tenantName));

    const adminBEmail = `admin-b-${randomUUID()}@test.local`;
    const tenantB = await call(app,'POST','/v1/platform/tenants',{name:'Other Tenant',adminEmail:adminBEmail},platform);
    assert.equal(tenantB.status,201,JSON.stringify(tenantB.data));
    assert.equal((await call(app,'POST','/v1/auth/invites/accept',{token:tenantB.data.adminInvite.token,password})).status,200);
    assert.equal((await call(app,'POST','/v1/platform/subscriptions',{tenantId:tenantB.data.id,planId:plan.data.id},platform)).status,201);
    const adminB = await loginAndMfa(app,pools,config,adminBEmail,password,'tenant');
    const otherList = await call(app,'GET','/v1/deliveries',undefined,adminB);
    assert.equal(otherList.status,200);
    assert.equal(otherList.data.items.length,0);
    const otherPhoto = await call(app,'GET',`/v1/delivery-photos/${detail.data.photos[0].id}`,undefined,adminB);
    assert.equal(otherPhoto.status,404);
    await assert.rejects(pools.platform.query('SELECT * FROM app.deliveries'), /permission denied/);

    const second = await call(app,'POST','/v1/deliveries',createBody,admin);
    assert.equal(second.status,201,JSON.stringify(second.data));
    const sameOp = randomUUID();
    const sameBody = {...checkInBody,clientOperationId:sameOp,occurredAt:new Date().toISOString()};
    const simultaneous = await Promise.all([
      call(app,'POST',`/v1/deliveries/${second.data.id}/check-ins`,sameBody,courier),
      call(app,'POST',`/v1/deliveries/${second.data.id}/check-ins`,sameBody,courier),
    ]);
    assert.deepEqual(simultaneous.map(item => item.status),[200,200]);
    assert.deepEqual(simultaneous.map(item => item.data.replayed).sort(),[false,true]);

    const badPhotoBoundary = 'bad-photo';
    const badPhoto = Buffer.from(`--${badPhotoBoundary}\r\nContent-Disposition: form-data; name="clientOperationId"\r\n\r\n${randomUUID()}\r\n`+
      `--${badPhotoBoundary}\r\nContent-Disposition: form-data; name="occurredAt"\r\n\r\n${new Date().toISOString()}\r\n`+
      `--${badPhotoBoundary}\r\nContent-Disposition: form-data; name="photo"; filename="bad.jpg"\r\nContent-Type: image/jpeg\r\n\r\nnot-an-image\r\n`+
      `--${badPhotoBoundary}--\r\n`);
    const failedPhoto = await app.inject({method:'POST',url:`/v1/deliveries/${second.data.id}/completion`,
      headers:{...headers(courier),'content-type':`multipart/form-data; boundary=${badPhotoBoundary}`},payload:badPhoto});
    assert.equal(failedPhoto.statusCode,400,failedPhoto.body);
    const stillOpen = await call(app,'GET',`/v1/deliveries/${second.data.id}`,undefined,admin);
    assert.equal(stillOpen.data.status,'in_progress');
    assert.equal(stillOpen.data.photos.length,0);

    const notification = await pools.worker.query<{ id: string }>(`SELECT id FROM app.notification_outbox
      WHERE delivery_id=$1 ORDER BY created_at DESC LIMIT 1`,[second.data.id]);
    await pools.worker.query(`UPDATE app.notification_outbox SET status='processing',available_at=now()-interval '11 minutes'
      WHERE id=$1`,[notification.rows[0]!.id]);
    let sent = 0;
    const worker = createNotificationWorker(pools,config,async (_token,deliveryId) => {
      if (deliveryId === second.data.id) sent++;
    });
    assert.ok((await worker.recoverStale()) >= 1);
    for (let i=0; i<10 && sent===0; i++) await worker.processBatch();
    assert.equal(sent,1);
    const deliveredNotification = await pools.worker.query<{ status: string }>(
      'SELECT status FROM app.notification_outbox WHERE id=$1',[notification.rows[0]!.id]);
    assert.equal(deliveredNotification.rows[0]!.status,'sent');
    await worker.recordHeartbeat(undefined,'no_credential');
    const workerDashboard = await call(app,'GET','/v1/tenant/dashboard?period=day',undefined,admin);
    assert.equal(workerDashboard.status,200,JSON.stringify(workerDashboard.data));
    assert.equal(workerDashboard.data.worker.status,'no_credential');
    const staging = join(dir,'staging');
    await mkdir(staging,{recursive:true});
    const orphan = join(staging,'orphan.part');
    await writeFile(orphan,'orphan');
    const old = new Date(Date.now()-48*60*60*1000);
    await utimes(orphan,old,old);
    assert.ok((await worker.cleanupOrphans()) >= 1);
    await assert.rejects(access(orphan));
    const expiredPoint=await pools.worker.query('SELECT 1 FROM app.delivery_route_locations WHERE tenant_id=$1 AND client_point_id=$2',[tenantId,expiredRoutePointId]);
    assert.equal(expiredPoint.rowCount,0,'the worker deletes GPS history older than 30 days');

    const problemBody = {clientOperationId:randomUUID(),note:'Destinatário ausente'};
    const problem = await call(app,'POST',`/v1/deliveries/${second.data.id}/problem`,problemBody,courier);
    assert.equal(problem.status,200,JSON.stringify(problem.data));
    const problemReplay = await call(app,'POST',`/v1/deliveries/${second.data.id}/problem`,problemBody,courier);
    assert.equal(problemReplay.data.replayed,true);
    assert.equal((await call(app,'GET',`/v1/deliveries/${second.data.id}`,undefined,admin)).data.status,'problem');

    const courier2Email = `courier2-${randomUUID()}@test.local`;
    const invite2 = await call(app,'POST','/v1/tenant/invites',{email:courier2Email,role:'courier'},admin);
    assert.equal(invite2.status,201);
    assert.equal((await call(app,'POST','/v1/auth/invites/accept',{token:invite2.data.token,password})).status,200);
    const login2 = await call(app,'POST','/v1/auth/login',{email:courier2Email,password,scope:'tenant',client:'mobile'});
    const courier2: Session = {token:login2.data.token};
    const me2 = await call(app,'GET','/v1/auth/me',undefined,courier2);
    const membership2 = me2.data.membershipId as string;
    const volume = await call(app,'POST','/v1/tenant/delivery-items',{name:'Galão 20 L',iconKey:'water'},admin);
    assert.equal(volume.status,201,JSON.stringify(volume.data));
    const volumeDelivery=await call(app,'POST','/v1/deliveries',{customerId:customer.data.id,addressId:address.data.id,
      courierMembershipId,items:[{catalogItemId:volume.data.id,quantity:3}]},admin);
    assert.equal(volumeDelivery.status,201,JSON.stringify(volumeDelivery.data));
    const volumeDetail=await call(app,'GET',`/v1/deliveries/${volumeDelivery.data.id}`,undefined,admin);
    assert.deepEqual(volumeDetail.data.items.map((item:{name:string;quantity:number;icon_key:string})=>({name:item.name,quantity:item.quantity,icon_key:item.icon_key})),[{name:'Galão 20 L',quantity:3,icon_key:'water'}]);
    assert.equal((await call(app,'PUT',`/v1/mobile/devices/${randomUUID()}`,
      {fcmToken:`fcm-${randomUUID()}`},courier2)).status,200);
    const availableDelivery=await call(app,'POST','/v1/deliveries',{customerId:customer.data.id,
      address:{street:'Rua do Teste',number:'45',city:'Fortaleza',state:'CE'},claimable:true,
      items:[{catalogItemId:volume.data.id,quantity:1}]},admin);
    assert.equal(availableDelivery.status,201,JSON.stringify(availableDelivery.data));
    const availableOutbox = await pools.worker.query<{device_count:string}>(`SELECT count(*) AS device_count FROM app.notification_outbox
      WHERE delivery_id=$1 AND event_type='delivery_available' AND status='pending'`,[availableDelivery.data.id]);
    assert.equal(Number(availableOutbox.rows[0]!.device_count),2);
    assert.equal((await call(app,'GET','/v1/deliveries',undefined,admin)).status,200);
    const availableToBoth=await Promise.all([call(app,'GET','/v1/mobile/available',undefined,courier),call(app,'GET','/v1/mobile/available',undefined,courier2)]);
    for(const result of availableToBoth){assert.equal(result.status,200,JSON.stringify(result.data));assert.ok(result.data.items.some((delivery:{id:string;items:Array<{quantity:number}>})=>delivery.id===availableDelivery.data.id&&delivery.items[0]?.quantity===1));}
    const claims=await Promise.all([call(app,'POST',`/v1/deliveries/${availableDelivery.data.id}/claim`,{},courier),call(app,'POST',`/v1/deliveries/${availableDelivery.data.id}/claim`,{},courier2)]);
    assert.deepEqual(claims.map(result=>result.status).sort(),[200,409]);
    const invalidatedAvailablePushes=await pools.worker.query<{status:string;last_error:string}>(`SELECT status,last_error FROM app.notification_outbox
      WHERE delivery_id=$1 AND event_type='delivery_available'`,[availableDelivery.data.id]);
    assert.equal(invalidatedAvailablePushes.rows.length,2);
    assert.ok(invalidatedAvailablePushes.rows.every(row=>row.status==='failed'&&row.last_error==='superseded'),JSON.stringify(invalidatedAvailablePushes.rows));
    const winningCourier=claims[0]!.status===200?courier:courier2;
    const claimSync=await call(app,'GET','/v1/mobile/sync',undefined,winningCourier);
    const claimedVolume=claimSync.data.items.find((delivery:{id:string})=>delivery.id===availableDelivery.data.id);
    assert.equal(claimedVolume.items[0].name,'Galão 20 L');
    const routeDetachment=await call(app,'POST',`/v1/deliveries/${dueToday.data.id}/assignment`,
      {courierMembershipId:membership2},admin);
    assert.equal(routeDetachment.status,200,JSON.stringify(routeDetachment.data));
    const exhaustedRoute=await call(app,'GET',`/v1/tenant/routes/${route.data.id}/live`,undefined,admin);
    assert.equal(exhaustedRoute.data.route.status,'active');
    assert.equal(exhaustedRoute.data.stops.find((stop:{delivery_id:string})=>stop.delivery_id===dueToday.data.id).status,'skipped');
    assert.equal(exhaustedRoute.data.stops.find((stop:{delivery_id:string})=>stop.delivery_id===future.data.id).status,'active');
    assert.equal((await call(app,'POST',`/v1/deliveries/${future.data.id}/assignment`,
      {courierMembershipId:membership2},admin)).status,200);
    const completedAfterDetach=await call(app,'GET',`/v1/tenant/routes/${route.data.id}/live`,undefined,admin);
    assert.equal(completedAfterDetach.data.route.status,'completed');
    assert.equal(completedAfterDetach.data.stops.find((stop:{delivery_id:string})=>stop.delivery_id===future.data.id).status,'skipped');
    const routeTarget=await call(app,'POST','/v1/deliveries',createBody,admin);
    assert.equal(routeTarget.status,201,JSON.stringify(routeTarget.data));
    const secondRoute=await call(app,'POST','/v1/mobile/routes',{deliveryIds:[routeTarget.data.id]},courier);
    assert.equal(secondRoute.status,200,JSON.stringify(secondRoute.data));
    assert.equal((await call(app,'POST',`/v1/mobile/routes/${secondRoute.data.id}/start`,{},courier)).status,200);
    assert.equal((await call(app,'PUT',`/v1/mobile/devices/${randomUUID()}`,
      {fcmToken:`fcm-${randomUUID()}`},courier2)).status,200);
    const reassigned = await call(app,'POST',`/v1/deliveries/${routeTarget.data.id}/assignment`,
      {courierMembershipId:membership2},admin);
    assert.equal(reassigned.status,200,JSON.stringify(reassigned.data));
    const detachedRoute=await call(app,'GET',`/v1/tenant/routes/${secondRoute.data.id}/live`,undefined,admin);
    assert.equal(detachedRoute.data.route.status,'cancelled');
    assert.equal(detachedRoute.data.stops[0].status,'skipped');
    assert.equal((await call(app,'POST',`/v1/deliveries/${second.data.id}/assignment`,
      {courierMembershipId:membership2},admin)).status,200);
    const oldSync = await call(app,'GET','/v1/mobile/sync',undefined,courier);
    assert.equal(oldSync.status,200,JSON.stringify(oldSync.data));
    assert.ok(oldSync.data.removedDeliveryIds.includes(second.data.id));
    const newSync = await call(app,'GET','/v1/mobile/sync',undefined,courier2);
    assert.ok(newSync.data.items.some((item: {id:string}) => item.id===second.data.id));
    assert.equal((await call(app,'GET',`/v1/deliveries/${second.data.id}`,undefined,courier)).status,404);
    const newCourierDetail = await call(app,'GET',`/v1/deliveries/${second.data.id}`,undefined,courier2);
    assert.equal(newCourierDetail.status,200);
    assert.ok(newCourierDetail.data.events.some((event: {kind:string}) => event.kind==='reassigned'));
    const checkIn2 = await call(app,'POST',`/v1/deliveries/${second.data.id}/check-ins`,
      {...checkInBody,clientOperationId:randomUUID(),occurredAt:new Date().toISOString()},courier2);
    assert.equal(checkIn2.status,200,JSON.stringify(checkIn2.data));
    const courier2SyncAfterCheckIn = await call(app,'GET','/v1/mobile/sync',undefined,courier2);
    const courier2Delivery = courier2SyncAfterCheckIn.data.items.find((item: {id:string}) => item.id===second.data.id);
    assert.equal(Number(courier2Delivery.last_check_in_latitude),checkInBody.latitude);
    assert.equal(Number(courier2Delivery.last_check_in_longitude),checkInBody.longitude);

    const sqlAdmin = new pg.Client({connectionString:url('postgres','local-dev-only')});
    await sqlAdmin.connect();
    try {
      const retainedPhoto = await sqlAdmin.query<{ storage_key: string }>(
        'SELECT storage_key FROM app.delivery_photos WHERE id=$1',[detail.data.photos[0].id]);
      await sqlAdmin.query(`UPDATE app.deliveries SET completed_at=now()-interval '181 days',updated_at=now()-interval '181 days' WHERE id=$1`,[deliveryId]);
      await sqlAdmin.query(`UPDATE app.delivery_photos SET created_at=now()-interval '181 days' WHERE id=$1`,[detail.data.photos[0].id]);
      assert.ok((await worker.cleanupOrphans()) >= 1);
      assert.equal((await sqlAdmin.query('SELECT 1 FROM app.delivery_photos WHERE id=$1',[detail.data.photos[0].id])).rowCount,0);
      await assert.rejects(access(join(dir,retainedPhoto.rows[0]!.storage_key)));
      const retainedEvent = await sqlAdmin.query<{ id: string }>(
        `SELECT id FROM app.delivery_events WHERE delivery_id=$1 AND kind='created' LIMIT 1`,[deliveryId]);
      await sqlAdmin.query(`UPDATE app.delivery_events SET occurred_at=now()-interval '366 days' WHERE id=$1`,[retainedEvent.rows[0]!.id]);
      assert.ok((await worker.cleanupOrphans()) >= 1);
      assert.equal((await sqlAdmin.query('SELECT 1 FROM app.delivery_events WHERE id=$1',[retainedEvent.rows[0]!.id])).rowCount,0);
      await sqlAdmin.query(`CREATE OR REPLACE FUNCTION app.api_test_fail_photo() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced photo failure'; END $$`);
      await sqlAdmin.query('DROP TRIGGER IF EXISTS api_test_fail_photo ON app.delivery_photos');
      await sqlAdmin.query(`CREATE TRIGGER api_test_fail_photo BEFORE INSERT ON app.delivery_photos
        FOR EACH ROW EXECUTE FUNCTION app.api_test_fail_photo()`);
      try {
        const failureOp = randomUUID();
        const failurePayload = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="clientOperationId"\r\n\r\n${failureOp}\r\n`),
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="occurredAt"\r\n\r\n${new Date().toISOString()}\r\n`),
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="proof.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
          photo,Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        const photoFailure = await app.inject({method:'POST',url:`/v1/deliveries/${second.data.id}/completion`,
          headers:{...headers(courier2),'content-type':`multipart/form-data; boundary=${boundary}`},
          payload:failurePayload});
        assert.equal(photoFailure.statusCode,500,photoFailure.body);
      } finally {
        await sqlAdmin.query('DROP TRIGGER api_test_fail_photo ON app.delivery_photos');
        await sqlAdmin.query('DROP FUNCTION app.api_test_fail_photo()');
      }
      const secondAfterFailure = await call(app,'GET',`/v1/deliveries/${second.data.id}`,undefined,admin);
      assert.equal(secondAfterFailure.data.status,'in_progress');
      assert.equal(secondAfterFailure.data.photos.length,0);
      assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(join(dir,tenantId,second.data.id))),[]);

      const counts = async () => (await sqlAdmin.query(`SELECT
        (SELECT count(*)::int FROM app.deliveries WHERE tenant_id=$1) AS deliveries,
        (SELECT count(*)::int FROM app.delivery_events WHERE tenant_id=$1) AS events,
        (SELECT count(*)::int FROM app.notification_outbox WHERE tenant_id=$1) AS notifications`,[tenantId])).rows[0];
      const before = await counts();
      await sqlAdmin.query(`CREATE OR REPLACE FUNCTION app.api_test_fail_outbox() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced outbox failure'; END $$`);
      await sqlAdmin.query('DROP TRIGGER IF EXISTS api_test_fail_outbox ON app.notification_outbox');
      await sqlAdmin.query(`CREATE TRIGGER api_test_fail_outbox BEFORE INSERT ON app.notification_outbox
        FOR EACH ROW EXECUTE FUNCTION app.api_test_fail_outbox()`);
      try {
        const failedCreation = await call(app,'POST','/v1/deliveries',createBody,admin);
        assert.equal(failedCreation.status,500,JSON.stringify(failedCreation.data));
      } finally {
        await sqlAdmin.query('DROP TRIGGER api_test_fail_outbox ON app.notification_outbox');
        await sqlAdmin.query('DROP FUNCTION app.api_test_fail_outbox()');
      }
      assert.deepEqual(await counts(),before);
    } finally { await sqlAdmin.end(); }

    const inactive = await call(app,'PATCH',`/v1/tenant/users/${membership2}/status`,{status:'inactive'},admin);
    assert.equal(inactive.status,200,JSON.stringify(inactive.data));
    assert.equal((await call(app,'GET','/v1/auth/me',undefined,courier2)).status,401);
    assert.equal((await call(app,'PATCH',`/v1/tenant/users/${membership2}/status`,
      {status:'active'},admin)).status,200);
    assert.equal((await call(app,'GET','/v1/auth/me',undefined,courier2)).status,401);

    const cancelTarget = await call(app,'POST','/v1/deliveries',
      {customerId:customer.data.id,addressId:address.data.id,courierMembershipId,merchandiseDescription:'Cancelar'},admin);
    assert.equal(cancelTarget.status,201);
    const cancelRoute=await call(app,'POST','/v1/mobile/routes',{deliveryIds:[cancelTarget.data.id]},courier);
    assert.equal(cancelRoute.status,200,JSON.stringify(cancelRoute.data));
    assert.equal((await call(app,'POST',`/v1/mobile/routes/${cancelRoute.data.id}/start`,{},courier)).status,200);
    assert.equal((await call(app,'POST',`/v1/deliveries/${cancelTarget.data.id}/cancel`,{note:'Teste'},admin)).status,200);
    assert.equal((await call(app,'GET',`/v1/deliveries/${cancelTarget.data.id}`,undefined,admin)).data.status,'cancelled');
    const cancelledRoute=await call(app,'GET',`/v1/tenant/routes/${cancelRoute.data.id}/live`,undefined,admin);
    assert.equal(cancelledRoute.data.route.status,'cancelled');
    assert.equal(cancelledRoute.data.stops[0].status,'skipped');
    const manualCancelTarget = await call(app,'POST','/v1/deliveries',
      {customerId:customer.data.id,addressId:address.data.id,courierMembershipId,merchandiseDescription:'Cancelar rota diretamente'},admin);
    assert.equal(manualCancelTarget.status,201);
    const manualCancelRoute = await call(app,'POST','/v1/mobile/routes',{deliveryIds:[manualCancelTarget.data.id]},courier);
    assert.equal(manualCancelRoute.status,200,JSON.stringify(manualCancelRoute.data));
    assert.equal((await call(app,'POST',`/v1/mobile/routes/${manualCancelRoute.data.id}/start`,{},courier)).status,200);
    assert.equal((await call(app,'POST',`/v1/mobile/routes/${manualCancelRoute.data.id}/cancel`,{},courier)).status,200);
    const manuallyCancelledRoute = await call(app,'GET',`/v1/tenant/routes/${manualCancelRoute.data.id}/live`,undefined,admin);
    assert.equal(manuallyCancelledRoute.data.route.status,'cancelled');
    assert.equal(manuallyCancelledRoute.data.stops[0].status,'skipped');
    assert.equal((await call(app,'POST',`/v1/deliveries/${deliveryId}/assignment`,
      {courierMembershipId},admin)).status,409);

    const logout = await call(app,'POST','/v1/auth/logout',{},courier);
    assert.equal(logout.status,200);
    assert.equal((await call(app,'GET','/v1/auth/me',undefined,courier)).status,401);
    const newLogin = await call(app,'POST','/v1/auth/login',{email:courierEmail,password,scope:'tenant',client:'mobile'});
    const token = newLogin.data.token as string;
    await pools.auth.query(`UPDATE app.auth_sessions SET created_at=now()-interval '2 days',
      expires_at=now()-interval '1 second'
      WHERE token_hash=$1`,[sha256(token)]);
    assert.equal((await call(app,'GET','/v1/auth/me',undefined,{token})).status,401);

    const suspend = await call(app,'PATCH',`/v1/platform/subscriptions/${subscription.data.id}/status`,{status:'suspended'},platform);
    assert.equal(suspend.status,200);
    assert.equal((await call(app,'GET','/v1/tenant/dashboard',undefined,admin)).status,401);
    assert.equal((await call(app,'PATCH',`/v1/platform/subscriptions/${subscription.data.id}/status`,{status:'active'},platform)).status,200);
    assert.equal((await call(app,'GET','/v1/tenant/dashboard',undefined,admin)).status,401);
    const adminRelogin = await call(app,'POST','/v1/auth/login',{email:adminEmail,password,scope:'tenant',client:'web'});
    const adminFresh: Session = {cookie:adminRelogin.response.headers['set-cookie']!.toString().split(';')[0]!,
      csrf:adminRelogin.data.csrfToken};
    assert.equal((await call(app,'POST','/v1/auth/mfa/verify',{code:admin.recoveryCodes![0]},adminFresh)).status,200);
    assert.equal((await call(app,'GET','/v1/tenant/dashboard',undefined,adminFresh)).status,200);

    const limited = await call(app,'PATCH',`/v1/platform/plans/${plan.data.id}`,
      {maxUsers:3,maxCouriers:2,maxMonthlyDeliveries:3,maxStorageBytes:1},platform);
    assert.equal(limited.status,200,JSON.stringify(limited.data));
    const extraInvite = await call(app,'POST','/v1/tenant/invites',
      {email:`extra-${randomUUID()}@test.local`,role:'courier'},adminFresh);
    assert.equal(extraInvite.status,201);
    assert.equal((await call(app,'POST','/v1/auth/invites/accept',
      {token:extraInvite.data.token,password})).status,409);
    assert.equal((await call(app,'POST','/v1/deliveries',createBody,adminFresh)).status,409);
    const courier2FreshLogin = await call(app,'POST','/v1/auth/login',
      {email:courier2Email,password,scope:'tenant',client:'mobile'});
    const quotaOperation = randomUUID();
    const quotaPayload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="clientOperationId"\r\n\r\n${quotaOperation}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="occurredAt"\r\n\r\n${new Date().toISOString()}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="proof.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      photo,Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const overQuota = await app.inject({method:'POST',url:`/v1/deliveries/${second.data.id}/completion`,
      headers:{authorization:`Bearer ${courier2FreshLogin.data.token}`,'content-type':`multipart/form-data; boundary=${boundary}`},
      payload:quotaPayload});
    assert.equal(overQuota.statusCode,409,overQuota.body);
    assert.equal((await call(app,'GET',`/v1/deliveries/${second.data.id}`,undefined,adminFresh)).data.status,'in_progress');

    const pendingPlatform = await call(app,'POST','/v1/auth/login',
      {email:platformEmail,password,scope:'platform',client:'web'});
    const pendingSession: Session = {cookie:pendingPlatform.response.headers['set-cookie']!.toString().split(';')[0]!,
      csrf:pendingPlatform.data.csrfToken};
    assert.equal((await call(app,'GET','/v1/platform/usage',undefined,pendingSession)).status,403);
    const recovery = await call(app,'POST','/v1/auth/mfa/verify',{code:platform.recoveryCodes![0]},pendingSession);
    assert.equal(recovery.status,200,JSON.stringify(recovery.data));
    const reusedRecovery = await call(app,'POST','/v1/auth/mfa/verify',{code:platform.recoveryCodes![0]},pendingSession);
    assert.equal(reusedRecovery.status,401);
    const platformUser = await pools.auth.query<{ id: string }>('SELECT id FROM app.users WHERE email=$1',[platformEmail]);
    const reset = await call(app,'POST',`/v1/platform/admins/${platformUser.rows[0]!.id}/password-reset`,{},pendingSession);
    assert.equal(reset.status,201,JSON.stringify(reset.data));
    assert.equal((await call(app,'POST','/v1/auth/invites/accept',
      {token:reset.data.token,password:'new-platform-password-123'})).status,401);
    assert.equal((await call(app,'POST','/v1/auth/invites/accept',
      {token:reset.data.token,password:'new-platform-password-123',mfaCode:platform.recoveryCodes![1]})).status,200);
    assert.equal((await call(app,'GET','/v1/auth/me',undefined,pendingSession)).status,401);
  } finally {
    await app.close();
    await rm(dir,{recursive:true,force:true});
  }
});
