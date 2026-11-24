import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth.js';
import { withTenant, type DbPools } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { preparePhoto } from '../storage.js';

const schema = { params: { type:'object', required:['id'], properties:{id:{type:'string',format:'uuid'}} } };
const mobilePath = '/v1/deliveries/:id/facade';
const managerPath = '/v1/tenant/addresses/:id/facade';
const activeDelivery = "d.status IN ('assigned','in_progress','problem')";
const captureAllowed = '(f.requested OR (f.image IS NULL AND f.first_delivery_id=d.id))';

export function registerFacadeRoutes(app: FastifyInstance, pools: DbPools) {
  for (const mobile of [true,false]) {
    app.get(mobile ? mobilePath : managerPath, {schema}, async (request,reply) => {
      const {identity} = await authenticate(request,pools);
      if (identity.scope !== 'tenant' || identity.role !== (mobile?'courier':'admin')) forbidden();
      const {id} = request.params as {id:string};
      reply.header('Cache-Control','private, no-store');
      return withTenant(pools,identity,async client => {
        const result = await client.query(mobile
          ? `SELECT f.image,f.revision,f.requested,(${activeDelivery} AND ${captureAllowed}) AS capture
             FROM app.deliveries d JOIN app.address_facades f USING(tenant_id,address_id)
             WHERE d.id=$1 AND d.courier_membership_id=app.current_membership_id()`
          : `SELECT f.image,f.revision,f.requested,false AS capture FROM app.addresses a
             LEFT JOIN app.address_facades f ON f.address_id=a.id AND f.tenant_id=a.tenant_id WHERE a.id=$1`, [id]);
        const row = result.rows[0] ?? notFound();
        return {image:row.image ? 'data:image/jpeg;base64,'+row.image.toString('base64') : null,
          revision:row.revision, requested:!!row.requested, capture:!!row.capture};
      });
    });
  }
  app.put(mobilePath,{schema},async request => {
    const {identity} = await authenticate(request,pools);
    if (identity.scope !== 'tenant' || identity.role !== 'courier') forbidden();
    const {id} = request.params as {id:string};
    let bytes:Buffer|undefined, revision='';
    for await (const part of request.parts()) {
      if (part.type==='file' && part.fieldname==='photo' && !bytes) {
        bytes=(await preparePhoto(await part.toBuffer(),part.mimetype)).bytes;
      } else if (part.type==='field' && part.fieldname==='revision') revision=String(part.value);
      else badRequest('Foto inválida.');
    }
    if (!bytes || !revision) badRequest('Informe a foto e o endereço.');
    return withTenant(pools,identity,async client => {
      const result=await client.query(`UPDATE app.address_facades f SET image=$2,requested=false,revision=gen_random_uuid()
        FROM app.deliveries d WHERE d.id=$1 AND d.courier_membership_id=app.current_membership_id()
        AND d.address_id=f.address_id AND d.tenant_id=f.tenant_id AND f.revision::text=$3
        AND ${activeDelivery} AND ${captureAllowed} RETURNING f.revision`,[id,bytes,revision]);
      return result.rows[0] ?? conflict('O endereço foi atualizado. Confira a foto atual.');
    });
  });
  app.patch(managerPath,{schema:{...schema,body:{type:'object',required:['action'],properties:{
    action:{enum:['request','remove']}},additionalProperties:false}}},async request => {
    const {identity}=await authenticate(request,pools);
    if(identity.scope!=='tenant'||identity.role!=='admin') forbidden();
    const {id}=request.params as {id:string};
    const {action}=request.body as {action:string};
    return withTenant(pools,identity,async client=>{
      const result=await client.query(`INSERT INTO app.address_facades (tenant_id,address_id,requested)
        SELECT tenant_id,id,true FROM app.addresses WHERE id=$1
        ON CONFLICT(tenant_id,address_id) DO UPDATE SET requested=true,revision=gen_random_uuid(),
        image=CASE WHEN $2='remove' THEN NULL ELSE address_facades.image END RETURNING revision`,[id,action]);
      return result.rows[0] ?? notFound();
    });
  });
}
