'use strict';
// Usage: BASE_URL=https://your-app.onrender.com API_KEY=... node scripts/smoke.js
// WARNING: calls /reset, which wipes all bookings and slots. Run it BEFORE you submit,
// then re-seed demo slots (see README).

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.API_KEY;
if (!KEY) { console.error('Set API_KEY'); process.exit(1); }

let failed = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : '  ->  ' + JSON.stringify(detail)));
  if (!ok) failed++;
}

async function call(method, path, body, headers = {}, key = KEY) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-API-Key': key } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json, headers: res.headers };
}

const hour = 3600e3;
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const future = Date.now() + 48 * hour;

(async () => {
  // Level 1 and 2: reset, auth
  let r = await call('POST', '/reset', { slots: [] }, {}, null);
  check('401 without key', r.status === 401 && r.json && r.json.error, r);
  r = await call('GET', '/slots', undefined, {}, 'wrong');
  check('401 with wrong key', r.status === 401, r);

  const slots = [
    { id: 'past', provider: 'Dr Ade', start: iso(Date.now() - 2 * hour), end: iso(Date.now() - hour) },
    { id: 's2', provider: 'Dr Ade', start: iso(future + hour), end: iso(future + 1.5 * hour) },
    { id: 's1', provider: 'Dr Ade', start: iso(future), end: iso(future + 0.5 * hour) },
    { id: 's3', provider: 'Dr Bola', start: iso(future + 2 * hour), end: iso(future + 2.5 * hour) },
    { id: 's4', provider: 'Dr Bola', start: iso(future + 3 * hour), end: iso(future + 3.5 * hour) },
    { id: 's5', provider: 'Dr Bola', start: iso(future + 4 * hour), end: iso(future + 4.5 * hour) },
  ];
  r = await call('POST', '/reset', { slots });
  check('reset 200', r.status === 200, r);

  r = await call('GET', '/slots');
  const ids = (r.json.slots || []).map((s) => s.id);
  check('slots sorted by start', ids.join() === 'past,s1,s2,s3,s4,s5', ids);
  check('slot start echoed unchanged', r.json.slots[1].start === slots[2].start, r.json.slots[1]);
  r = await call('GET', '/slots?provider=Dr%20Bola');
  check('provider filter', r.json.slots.length === 3 && r.json.slots.every((s) => s.provider === 'Dr Bola'), r.json);

  // Level 2: validation
  const bad = [
    [{ name: 'A', email: 'a@x.com' }, 400],
    [{ slot_id: 's1', name: '  ', email: 'a@x.com' }, 400],
    [{ slot_id: 's1', name: 'A', email: 'nope' }, 400],
    [{ slot_id: 'past', name: 'A', email: 'v1@x.com' }, 400],
    [{ slot_id: 'missing', name: 'A', email: 'v2@x.com' }, 404],
  ];
  for (const [body, want] of bad) {
    r = await call('POST', '/bookings', body);
    check(`validation ${JSON.stringify(body)} -> ${want}`, r.status === want && r.json && r.json.error, r);
  }

  // Level 1: book and look up, with trimming and lower-casing
  r = await call('POST', '/bookings', { slot_id: 's1', name: '  Ada Obi ', email: '  Ada@Example.COM ' });
  check('book 201 confirmed', r.status === 201 && r.json.status === 'confirmed', r);
  check('trimmed and lower-cased', r.json.name === 'Ada Obi' && r.json.email === 'ada@example.com', r.json);
  const first = r.json;
  r = await call('GET', '/bookings/' + first.id);
  check('lookup 200', r.status === 200 && r.json.id === first.id, r);
  r = await call('GET', '/bookings/nope');
  check('lookup 404', r.status === 404, r);
  r = await call('GET', '/slots');
  check('slot shows unavailable', r.json.slots.find((s) => s.id === 's1').available === false, r.json);

  // Level 3: 409, cancel, free slot, race
  r = await call('POST', '/bookings', { slot_id: 's1', name: 'Bob', email: 'bob@example.com' });
  check('double booking 409', r.status === 409, r);
  r = await call('DELETE', '/bookings/' + first.id);
  check('cancel 200', r.status === 200 && r.json.status === 'cancelled', r);
  r = await call('DELETE', '/bookings/' + first.id);
  check('cancel twice 409', r.status === 409, r);
  r = await call('DELETE', '/bookings/nope');
  check('cancel missing 404', r.status === 404, r);
  r = await call('POST', '/bookings', { slot_id: 's1', name: 'Bob', email: 'bob@example.com' });
  check('rebook after cancel 201', r.status === 201, r);

  const race = await Promise.all(
    Array.from({ length: 25 }, (_, i) => call('POST', '/bookings', { slot_id: 's2', name: 'R' + i, email: `race${i}@example.com` }))
  );
  const won = race.filter((x) => x.status === 201).length;
  const lost = race.filter((x) => x.status === 409).length;
  check('25 simultaneous requests: exactly one 201, rest 409', won === 1 && lost === 24, { won, lost });

  // Level 4: idempotency
  const h = { 'Idempotency-Key': 'key-' + Date.now() };
  const body = { slot_id: 's3', name: 'Ife', email: 'ife@example.com' };
  const [a, b] = await Promise.all([call('POST', '/bookings', body, h), call('POST', '/bookings', body, h)]);
  check('same key, same body: same status and id', a.status === 201 && b.status === 201 && a.json.id === b.json.id, [a, b]);
  r = await call('POST', '/bookings', body, h);
  check('retry later returns same booking', r.status === 201 && r.json.id === a.json.id, r);
  r = await call('POST', '/bookings', { ...body, name: 'Someone else' }, h);
  check('same key, different body -> 422', r.status === 422, r);
  r = await call('GET', '/bookings?email=IFE@example.com');
  check('only one booking created', r.json.bookings.length === 1, r.json);

  // Level 4: pagination (ife has s3; add s4, s5 for 3 total)
  await call('POST', '/bookings', { slot_id: 's4', name: 'Ife', email: 'ife@example.com' });
  await call('POST', '/bookings', { slot_id: 's5', name: 'Ife', email: 'ife@example.com' });
  r = await call('GET', '/bookings?email=ife@example.com&limit=2');
  check('page 1 has 2 and a cursor', r.json.bookings.length === 2 && !!r.json.next_cursor, r.json);
  const cur = r.json.next_cursor;
  const pageOneIds = r.json.bookings.map((x) => x.id);
  r = await call('GET', '/bookings?email=ife@example.com&limit=2&cursor=' + encodeURIComponent(cur));
  check('page 2 has 1 and null cursor', r.json.bookings.length === 1 && r.json.next_cursor === null && !pageOneIds.includes(r.json.bookings[0].id), r.json);
  for (const l of ['0', '51', 'abc', '-1']) {
    r = await call('GET', '/bookings?email=ife@example.com&limit=' + l);
    check('limit=' + l + ' -> 400', r.status === 400, r);
  }

  // Level 5: rate limit, failed attempts count
  const spam = [];
  for (let i = 0; i < 6; i++) spam.push(await call('POST', '/bookings', { slot_id: 'missing', name: 'S', email: 'spam@example.com' }));
  check('first 5 attempts get 404, 6th gets 429', spam.slice(0, 5).every((x) => x.status === 404) && spam[5].status === 429, spam.map((x) => x.status));
  const ra = Number(spam[5].headers.get('Retry-After'));
  check('Retry-After is whole seconds in 1..60', Number.isInteger(ra) && ra >= 1 && ra <= 60, ra);
  r = await call('POST', '/bookings', { slot_id: 'missing', name: 'S', email: 'other@example.com' });
  check('other email unaffected', r.status === 404, r);

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
