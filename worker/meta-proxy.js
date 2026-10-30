// Tuck and Whisper — Meta Model API proxy (Cloudflare Worker)
//
// Purpose: the Meta Model API key lives ONLY here, as a Worker secret.
// The PWA calls this Worker; the Worker forwards to the Meta Model API.
//
// Required configuration (Worker Settings → Variables and Secrets):
//   META_API_KEY   (Secret)  — your Meta Model API key
//   META_API_BASE  (Variable) — the API base URL from dev.meta.ai → Documentation
//                               (the same base your Codex setup already uses)
//
// Routes:
//   GET  /api/health  → { ok: true }
//   POST /api/spark   → forwards the JSON body to {META_API_BASE}/chat/completions
//                       with model "muse-spark-1.3" unless the body overrides it.
//
// NOTE: until META_API_BASE is set from the official docs, /api/spark returns 500
// with an explanatory message. Do not hardcode a guessed base URL.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/api/health') return json({ ok: true });

    if (url.pathname === '/api/spark' && request.method === 'POST') {
      if (!env.META_API_KEY) return json({ error: 'META_API_KEY secret is not set on this Worker.' }, 500);
      if (!env.META_API_BASE) return json({ error: 'META_API_BASE variable is not set. Copy the base URL from dev.meta.ai Documentation.' }, 500);

      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }
      if (!body.model) body.model = 'muse-spark-1.3';

      const upstream = await fetch(env.META_API_BASE.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + env.META_API_KEY,
        },
        body: JSON.stringify(body),
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    return json({ error: 'Not found' }, 404);
  },
};
