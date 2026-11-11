'use strict';

const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error('API_KEY environment variable is required');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 10,
});

const RATE_LIMIT = 5; // attempts per email
const RATE_WINDOW_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- schema ----------

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id        text PRIMARY KEY,
      provider  text NOT NULL,
      start_raw text NOT NULL,
      end_raw   text NOT NULL,
      start_ts  timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      seq        bigserial UNIQUE,
      id         text PRIMARY KEY,
      slot_id    text NOT NULL,
      name       text NOT NULL,
      email      text NOT NULL,
      status     text NOT NULL DEFAULT 'confirmed',
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    -- Level 3: the database itself refuses a second confirmed booking for a slot,
    -- so concurrent requests can never both win. Cancelled rows don't count.
    CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
      ON bookings (slot_id) WHERE status = 'confirmed';
    CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);
    -- Level 4
    CREATE TABLE IF NOT EXISTS idempotency (
      key       text PRIMARY KEY,
      body_hash text NOT NULL,
      status    integer NOT NULL,
      response  jsonb NOT NULL
    );
    -- Level 5
    CREATE TABLE IF NOT EXISTS attempts (
      email text NOT NULL,
      ts    timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE INDEX IF NOT EXISTS attempts_email_ts ON attempts (email, ts);
  `);
}

// ---------- helpers ----------

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isObj(v)) {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function toBooking(r) {
  return {
    id: r.id,
    slot_id: r.slot_id,
    name: r.name,
    email: r.email,
    status: r.status,
    created_at: new Date(r.created_at).toISOString(),
  };
}

const err = (status, message, extra = {}) => ({ status, body: { error: message }, ...extra });

// ---------- app ----------

const app = express();
app.disable('x-powered-by');

// The web page is public; every API route below needs the key.
app.use(express.static(path.join(__dirname, 'public')));

// Level 2: API key
app.use((req, res, next) => {
  const given = Buffer.from(req.get('X-API-Key') || '');
  const real = Buffer.from(API_KEY);
  if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
    return res.status(401).json({ error: 'missing or invalid API key' });
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

// Level 1: replace all slots (and wipe bookings)
app.post('/reset', ah(async (req, res) => {
  const slots = isObj(req.body) ? req.body.slots : null;
  if (!Array.isArray(slots)) return res.status(400).json({ error: 'slots must be an array' });

  const ids = [], providers = [], starts = [], ends = [], startTs = [];
  const seen = new Set();
  for (const s of slots) {
    if (!isObj(s) || [s.id, s.provider, s.start, s.end].some((v) => typeof v !== 'string' || !v.trim())) {
      return res.status(400).json({ error: 'each slot needs string id, provider, start and end' });
    }
    const t = Date.parse(s.start);
    if (Number.isNaN(t) || Number.isNaN(Date.parse(s.end))) {
      return res.status(400).json({ error: 'slot start and end must be date-times' });
    }
    if (seen.has(s.id)) return res.status(400).json({ error: `duplicate slot id: ${s.id}` });
    seen.add(s.id);
    ids.push(s.id); providers.push(s.provider); starts.push(s.start); ends.push(s.end);
    startTs.push(new Date(t).toISOString());
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM bookings');
    await client.query('DELETE FROM slots');
    await client.query('DELETE FROM idempotency');
    await client.query('DELETE FROM attempts');
    if (ids.length) {
      await client.query(
        `INSERT INTO slots (id, provider, start_raw, end_raw, start_ts)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[])`,
        [ids, providers, starts, ends, startTs]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true, slots: ids.length });
}));

// Level 1: list slots, earliest first
app.get('/slots', ah(async (req, res) => {
  const params = [];
  let where = '';
  if (typeof req.query.provider === 'string') {
    params.push(req.query.provider);
    where = 'WHERE s.provider = $1';
  }
  const r = await pool.query(
    `SELECT s.id, s.provider, s.start_raw, s.end_raw,
            NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s ${where}
      ORDER BY s.start_ts, s.id`,
    params
  );
  res.json({
    slots: r.rows.map((x) => ({
      id: x.id, provider: x.provider, start: x.start_raw, end: x.end_raw, available: x.available,
    })),
  });
}));

// Levels 1-5: book a slot. Runs in one transaction.
async function createBooking(client, { idemKey, bodyHash, slotId, name, email, emailOk }) {
  // Level 4: serialise requests that share a key, then replay a stored answer.
  if (idemKey) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['idem:' + idemKey]);
    const prev = await client.query('SELECT body_hash, status, response FROM idempotency WHERE key = $1', [idemKey]);
    if (prev.rowCount) {
      const p = prev.rows[0];
      if (p.body_hash !== bodyHash) {
        return err(422, 'Idempotency-Key was already used with a different request body');
      }
      return { status: p.status, body: p.response, replayed: true };
    }
  }

  // Level 5: at most 5 attempts per email per minute, failures included.
  // The advisory lock makes the count-then-insert atomic for that email.
  if (emailOk) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['rl:' + email]);
    await client.query(
      `DELETE FROM attempts WHERE email = $1 AND ts < clock_timestamp() - make_interval(secs => $2)`,
      [email, RATE_WINDOW_SECONDS]
    );
    const c = await client.query(
      `SELECT count(*)::int AS n,
              EXTRACT(EPOCH FROM (min(ts) + make_interval(secs => $2) - clock_timestamp())) AS wait
         FROM attempts WHERE email = $1`,
      [email, RATE_WINDOW_SECONDS]
    );
    if (c.rows[0].n >= RATE_LIMIT) {
      const wait = Math.max(1, Math.ceil(Number(c.rows[0].wait)));
      return err(429, 'too many booking attempts for this email, try again later', {
        headers: { 'Retry-After': String(wait) },
        noStore: true,
      });
    }
    await client.query('INSERT INTO attempts (email) VALUES ($1)', [email]);
  }

  // Level 2: validation
  if (!slotId || !name || !email) return err(400, 'slot_id, name and email are required');
  if (!emailOk) return err(400, 'email is not valid');

  const slot = await client.query('SELECT start_ts FROM slots WHERE id = $1', [slotId]);
  if (!slot.rowCount) return err(404, 'slot not found');
  if (new Date(slot.rows[0].start_ts) <= new Date()) return err(400, 'slot has already started');

  // Level 3: the unique partial index decides the winner.
  await client.query('SAVEPOINT ins');
  try {
    const ins = await client.query(
      `INSERT INTO bookings (id, slot_id, name, email, status)
       VALUES ($1, $2, $3, $4, 'confirmed') RETURNING id, slot_id, name, email, status, created_at`,
      [crypto.randomUUID(), slotId, name, email]
    );
    return { status: 201, body: toBooking(ins.rows[0]) };
  } catch (e) {
    if (e.code === '23505') {
      await client.query('ROLLBACK TO SAVEPOINT ins');
      return err(409, 'slot is already booked');
    }
    throw e;
  }
}

app.post('/bookings', ah(async (req, res) => {
  const body = req.body;
  if (!isObj(body)) return res.status(400).json({ error: 'request body must be a JSON object' });

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const input = {
    idemKey: (req.get('Idempotency-Key') || '').trim() || null,
    bodyHash: sha(canon(body)),
    slotId: typeof body.slot_id === 'string' ? body.slot_id.trim() : '',
    name: typeof body.name === 'string' ? body.name.trim() : '',
    email,
    emailOk: EMAIL_RE.test(email),
  };

  const client = await pool.connect();
  let out;
  try {
    await client.query('BEGIN');
    out = await createBooking(client, input);
    if (input.idemKey && !out.noStore && !out.replayed && out.status !== 422 && out.status < 500) {
      await client.query(
        `INSERT INTO idempotency (key, body_hash, status, response) VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO NOTHING`,
        [input.idemKey, input.bodyHash, out.status, JSON.stringify(out.body)]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (out.headers) res.set(out.headers);
  res.status(out.status).json(out.body);
}));

// Level 4: a person's bookings, oldest first, cursor pagination
app.get('/bookings', ah(async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!email) return res.status(400).json({ error: 'email is required' });

  let limit = 10;
  if (req.query.limit !== undefined) {
    const l = req.query.limit;
    if (typeof l !== 'string' || !/^\d+$/.test(l)) return res.status(400).json({ error: 'limit must be a whole number from 1 to 50' });
    limit = parseInt(l, 10);
    if (limit < 1 || limit > 50) return res.status(400).json({ error: 'limit must be a whole number from 1 to 50' });
  }

  let after = '0';
  if (req.query.cursor !== undefined) {
    const decoded = typeof req.query.cursor === 'string' ? Buffer.from(req.query.cursor, 'base64url').toString() : '';
    if (!/^\d{1,18}$/.test(decoded)) return res.status(400).json({ error: 'invalid cursor' });
    after = decoded;
  }

  const r = await pool.query(
    `SELECT seq, id, slot_id, name, email, status, created_at
       FROM bookings WHERE email = $1 AND seq > $2::bigint
      ORDER BY seq LIMIT $3`,
    [email, after, limit + 1]
  );
  const page = r.rows.slice(0, limit);
  const next = r.rows.length > limit ? Buffer.from(String(page[page.length - 1].seq)).toString('base64url') : null;
  res.json({ bookings: page.map(toBooking), next_cursor: next });
}));

app.get('/bookings/:id', ah(async (req, res) => {
  const r = await pool.query('SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = $1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'booking not found' });
  res.json(toBooking(r.rows[0]));
}));

// Level 3: cancel, which frees the slot
app.delete('/bookings/:id', ah(async (req, res) => {
  const r = await pool.query(
    `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed'
     RETURNING id, slot_id, name, email, status, created_at`,
    [req.params.id]
  );
  if (r.rowCount) return res.json(toBooking(r.rows[0]));
  const exists = await pool.query('SELECT 1 FROM bookings WHERE id = $1', [req.params.id]);
  if (!exists.rowCount) return res.status(404).json({ error: 'booking not found' });
  res.status(409).json({ error: 'booking is already cancelled' });
}));

app.use((req, res) => res.status(404).json({ error: 'not found' }));

app.use((e, req, res, next) => { // eslint-disable-line no-unused-vars
  if (e.type === 'entity.parse.failed') return res.status(400).json({ error: 'request body is not valid JSON' });
  console.error(e);
  res.status(500).json({ error: 'internal error' });
});

const port = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(port, () => console.log(`listening on ${port}`)))
  .catch((e) => { console.error('failed to start', e); process.exit(1); });
