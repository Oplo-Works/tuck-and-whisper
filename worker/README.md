# meta-proxy — setup

1. Cloudflare Dashboard → Workers & Pages → Create → Worker. Name: `taw-meta-proxy`.
2. Replace the default code with `meta-proxy.js` from this folder. Save and deploy.
3. Worker → Settings → Variables and Secrets:
   - Add **Secret** `META_API_KEY` = your Meta Model API key.
   - Add **Variable** `META_API_BASE` = the API base URL shown in dev.meta.ai → Documentation (same base your Codex setup uses).
   - (Optional) To open the PWA from your own domain, add **Variable** `ALLOWED_ORIGINS` = that hostname (comma-separated list) — otherwise API calls from it are rejected.
4. Open `https://<your-worker>.workers.dev/api/health` → `{ "ok": true }`.
5. Point the PWA's API base at the Worker URL.

The key is never stored in this repo or in the client app.
