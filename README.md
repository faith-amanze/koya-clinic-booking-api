# Clinic booking API

Node.js (Express) + Postgres. Implements the Koya Cohort 4 Task 1 contract, levels 1 to 5, and serves a small web page at `/`.

## How each level is handled

| Level | Approach |
|---|---|
| 1 | `POST /reset`, `GET /slots`, `POST /bookings`, `GET /bookings/{id}`. Slot `start`/`end` are stored as sent and echoed back unchanged. |
| 2 | `X-API-Key` middleware on every API route (constant-time compare, 401). Validation returns 400 / 404 / 400 in the order the spec lists. `name` and `email` are trimmed and `email` is lower-cased. |
| 3 | A **unique partial index** on `bookings(slot_id) WHERE status = 'confirmed'`. The database picks the winner, so simultaneous requests cannot both succeed. The loser gets 409. `DELETE /bookings/{id}` sets `cancelled`, which frees the slot automatically. |
| 4 | `Idempotency-Key` is stored with a hash of the canonicalised body and the final response. Same key and body replays the stored status and body. Same key and a different body returns 422. A per-key advisory lock makes two simultaneous retries safe. Bookings list uses an opaque cursor (the booking's insert sequence), oldest first. |
| 5 | Attempts are logged in Postgres per email. A per-email advisory lock makes count-then-insert atomic, so it holds across instances and restarts. The 6th attempt in 60 seconds returns 429 with `Retry-After` in whole seconds. Failed attempts count. Idempotent replays do not. |

## Run locally

```bash
npm install
export API_KEY=choose-a-long-random-string
export DATABASE_URL=postgres://user:pass@localhost:5432/clinic
export DATABASE_SSL=false          # only for local Postgres without SSL
npm start
```

Tables are created automatically at start-up.

## Deploy (free): Neon + Render

1. **Database.** Create a project at neon.tech and copy the connection string (it ends with `sslmode=require`).
2. **GitHub.** Push this folder to a public repo. Do not commit `.env`.
3. **Render.** New > Web Service > connect the repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variables: `API_KEY` (your key) and `DATABASE_URL` (the Neon string).
4. Open the Render URL. That is both your API base URL and your web page URL.

Render's free tier sleeps after inactivity, and the first request after a sleep can take a while. Open the URL yourself shortly before submitting, and consider a free uptime pinger.

## Seed demo slots

The page shows nothing until slots exist. Pick dates in the future:

```bash
curl -X POST "$BASE_URL/reset" -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" -d '{
  "slots": [
    {"id":"s1","provider":"Dr Ade","start":"2026-12-10T09:00:00Z","end":"2026-12-10T09:30:00Z"},
    {"id":"s2","provider":"Dr Ade","start":"2026-12-10T09:30:00Z","end":"2026-12-10T10:00:00Z"},
    {"id":"s3","provider":"Dr Bola","start":"2026-12-10T10:00:00Z","end":"2026-12-10T10:30:00Z"}
  ]
}'
```

On the page, paste your API key into the "Clinic access key" box once. It is kept in that browser only.

## Test everything

```bash
BASE_URL=https://your-app.onrender.com API_KEY=... npm run smoke
```

This covers all five levels, including 25 simultaneous bookings of one slot. It calls `/reset`, so run it **before** you submit and re-seed afterwards.

## Submission checklist

- API base URL: your Render URL, no trailing slash
- API key
- Web page URL: same Render URL
- GitHub repo URL (public)
- Loom (5 min or less): book a slot on the page, show the confirmation, then walk through the unique index (level 3), the idempotency table (level 4) and the attempts table with advisory lock (level 5)
- Do not redeploy or change anything after submitting
