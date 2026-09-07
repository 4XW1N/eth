# Dunes Student Portal

A student dashboard that shows real-time circulars (with PDF attachments) by
authenticating with and proxying the school's Digital Campus ICT portal.

## Layout

- `index.html` / `login.html` — frontend (served on GitHub Pages as a static shell)
- `server/` — the actual backend (`serve.js`) that authenticates, decrypts the
  circulars API (AES-GCM), and proxies portal requests. Serves the frontend too.
- `render.yaml` — Render Blueprint for hosting the full backend

## Hosting the full app

The portal needs the Node backend to talk to `ict.dunesinternationalschool.com`
and decrypt the API. GitHub Pages is static-only, so the live-with-data site must
run the backend. Two ways:

### Option A — Render (recommended, free tier)
1. Push this repo to GitHub.
2. In Render dashboard: **New → Blueprint** → select this repo.
   `render.yaml` is picked up automatically (`rootDir: server`).
3. Set the `PORTAL_KEY` environment variable to a strong shared secret.

### Option B — Any Node host
```
cd server
npm install
PORT=8080 PORTAL_KEY=your-secret node serve.js
```

## Privacy / security

- Set `PORTAL_KEY` (env). Requests to the proxy/API must send it via the
  `x-portal-key` header (or `?key=` query) — otherwise they get `403`.
- `/api/*`, `/circulars`, `/profile`, `/logout` and the auth POST are
  rate-limited (120 req/min per IP) to blunt brute-force abuse.
- Session cookies are kept in `server/data/` (gitignored). On Render, point
  `DATA_DIR` at a persistent/ephemeral volume (default `/tmp/data`).

> Warning: hosting the login proxy publicly means anyone with the key could use
> it to reach the school portal. Keep `PORTAL_KEY` secret and enable at least the
> rate limiter.
