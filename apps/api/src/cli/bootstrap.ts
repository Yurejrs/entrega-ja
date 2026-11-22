import argon2 from 'argon2';
import pg from 'pg';

const url = process.env.DATABASE_URL_AUTH;
const email = process.env.BOOTSTRAP_EMAIL?.toLowerCase().trim();
const password = process.env.BOOTSTRAP_PASSWORD;
if (!url || !email || !password || !email.includes('@') || password.length < 8) {
  throw new Error('Set DATABASE_URL_AUTH, BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD (at least 8 characters)');
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(19371001)');
  const existing = await client.query('SELECT 1 FROM app.users WHERE is_platform_admin=true LIMIT 1');
  if (existing.rowCount) throw new Error('A platform administrator already exists');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await client.query(`INSERT INTO app.users(email,password_hash,full_name,is_platform_admin)
    VALUES ($1,$2,$3,true)`, [email, hash, email.split('@')[0]]);
  await client.query('COMMIT');
  process.stdout.write(`Platform administrator created: ${email}\n`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
