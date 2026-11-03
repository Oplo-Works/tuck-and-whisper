// Tuck and Whisper — Meta Model API proxy (Cloudflare Worker)
//
// Purpose: the Meta Model API key lives ONLY here, as a Worker secret.
// The PWA calls this Worker; the Worker forwards to the Meta Model API.
//
// Required configuration (Worker Settings → Variables and Secrets):
//   META_API_KEY      (Secret)    — your Meta Model API key
//   META_API_BASE     (Variable, optional) — defaults to https://api.meta.ai/v1
//                                   (verified in the official docs at dev.meta.ai/docs/overview)
//   ALLOWED_ORIGINS   (Variable, optional) — comma-separated extra hostnames allowed to call
//                                   the API routes (e.g. "blog.example.com,app.example.org").
//                                   The Pages site, its previews, and localhost are always allowed.
//
// Routes (hardened — audit P1-3 / P2-4):
//   GET  /api/health  → { ok: true } (GET only; anything else is 405)
//   POST /api/spark   → forwards the JSON body to {META_API_BASE}/chat/completions.
//                       Body must be a JSON object with a messages array; model must be
//                       on the allowlist (muse-spark-1.3 default). Malformed → 400 JSON.
//   POST /api/image   → forwards the JSON body to {META_API_BASE}/images/edits.
//                       Body must be a JSON object with prompt (filled string) and a
//                       non-empty images array; model allowlisted (muse-image-1.0 default).
//   POST /api/voice   → multipart/form-data only (≤ 32MB): part "request" (JSON settings;
//                       model allowlisted, muse-voice-transcribe-1.0 default) and part
//                       "audio" (WAV mono 16-bit PCM, 16k or 24k Hz). The request part is
//                       validated and re-serialized; the audio part is forwarded as-is.
//                       The API accepts WAV only, so the PWA converts phone recordings
//                       (Android m4a etc.) to WAV in the browser (WebAudio decode → PCM
//                       WAV) before upload. Users never handle formats or conversion.
//
// All error responses are JSON with CORS headers. Upstream fetch failures return a
// JSON 502 (never a bare stack or an HTML error page). NOTE: repo code only — the
// founder deploys this Worker from the Cloudflare dashboard.

// The Worker URL is public, so API routes only accept browser calls from our own
// Pages site (incl. preview deployments), local dev servers, or hosts listed in the
// ALLOWED_ORIGINS variable. This keeps strangers from burning the API credit. CLI
// tests must send an Origin header:
//   -H "Origin: https://tuck-and-whisper.pages.dev"
const PAGE_HOST = 'tuck-and-whisper.pages.dev';

function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  let host;
  try { host = new URL(origin).hostname; } catch { return false; }
  if (host === PAGE_HOST || host.endsWith('.' + PAGE_HOST)
    || host === 'localhost' || host === '127.0.0.1') return true;
  const extra = String((env && env.ALLOWED_ORIGINS) || '').split(',');
  return extra.map((s) => s.trim()).filter(Boolean).some((h) => host === h);
}

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

const ALLOWED_MODELS = new Set(['muse-spark-1.3', 'muse-image-1.0', 'muse-voice-transcribe-1.0']);
const MAX_VOICE_BYTES = 32 * 1024 * 1024;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function filledString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// (P1-3c) Missing model → the route's default. A model outside the allowlist → null
// (the caller answers 400). Values are never forwarded unvalidated.
function resolveModel(body, routeDefault) {
  if (body.model === undefined || body.model === null || body.model === '') return routeDefault;
  return ALLOWED_MODELS.has(body.model) ? body.model : null;
}

async function forwardJson(upstreamUrl, apiKey, body) {
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return json({ error: 'Upstream request failed.' }, 502);
  }
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
      return json({ ok: true });
    }

    if (url.pathname === '/api/spark' && request.method === 'POST') {
      if (!originAllowed(request, env)) return json({ error: 'Origin not allowed.' }, 403);
      if (!env.META_API_KEY) return json({ error: 'META_API_KEY secret is not set on this Worker.' }, 500);
      const base = env.META_API_BASE || 'https://api.meta.ai/v1';

      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }
      if (!isPlainObject(body)) return json({ error: 'JSON body must be an object.' }, 400);
      if (!Array.isArray(body.messages)) return json({ error: 'messages must be an array.' }, 400);
      const model = resolveModel(body, 'muse-spark-1.3');
      if (!model) return json({ error: 'Model not allowed.' }, 400);
      body.model = model;

      return forwardJson(base.replace(/\/$/, '') + '/chat/completions', env.META_API_KEY, body);
    }

    if (url.pathname === '/api/image' && request.method === 'POST') {
      if (!originAllowed(request, env)) return json({ error: 'Origin not allowed.' }, 403);
      if (!env.META_API_KEY) return json({ error: 'META_API_KEY secret is not set on this Worker.' }, 500);
      const base = env.META_API_BASE || 'https://api.meta.ai/v1';

      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }
      if (!isPlainObject(body)) return json({ error: 'JSON body must be an object.' }, 400);
      if (!filledString(body.prompt)) return json({ error: 'prompt is required.' }, 400);
      // An empty images array is a text-only illustration request (paragraph
      // artwork without a photo); a non-array images value is still rejected.
      if (body.images !== undefined && !Array.isArray(body.images)) {
        return json({ error: 'images must be an array.' }, 400);
      }
      const model = resolveModel(body, 'muse-image-1.0');
      if (!model) return json({ error: 'Model not allowed.' }, 400);
      body.model = model;

      return forwardJson(base.replace(/\/$/, '') + '/images/edits', env.META_API_KEY, body);
    }

    if (url.pathname === '/api/voice' && request.method === 'POST') {
      if (!originAllowed(request, env)) return json({ error: 'Origin not allowed.' }, 403);
      if (!env.META_API_KEY) return json({ error: 'META_API_KEY secret is not set on this Worker.' }, 500);
      const base = env.META_API_BASE || 'https://api.meta.ai/v1';

      const contentType = request.headers.get('Content-Type') || '';
      if (!contentType.toLowerCase().includes('multipart/form-data')) {
        return json({ error: 'multipart/form-data required.' }, 400);
      }
      const declared = Number(request.headers.get('Content-Length') || '0');
      if (declared > MAX_VOICE_BYTES) {
        return json({ error: 'Voice body too large (limit 32MB).' }, 413);
      }

      // The "request" part is validated (object + allowlisted model) and re-serialized
      // with any defaulted fields; the "audio" part is forwarded untouched.
      let form;
      try { form = await request.formData(); } catch { return json({ error: 'Invalid multipart body.' }, 400); }
      const reqPart = form.get('request');
      if (!reqPart) return json({ error: 'request part is required.' }, 400);
      let settings;
      try {
        settings = JSON.parse(typeof reqPart === 'string' ? reqPart : await reqPart.text());
      } catch { return json({ error: 'request part must be JSON.' }, 400); }
      if (!isPlainObject(settings)) return json({ error: 'request part must be a JSON object.' }, 400);
      const model = resolveModel(settings, 'muse-voice-transcribe-1.0');
      if (!model) return json({ error: 'Model not allowed.' }, 400);
      settings.model = model;
      const audio = form.get('audio');
      if (!audio || typeof audio === 'string') return json({ error: 'audio part is required.' }, 400);

      const upstreamForm = new FormData();
      upstreamForm.append('request', new Blob([JSON.stringify(settings)], { type: 'application/json' }), 'request.json');
      upstreamForm.append('audio', audio, audio.name || 'audio.wav');
      let upstream;
      try {
        upstream = await fetch(base.replace(/\/$/, '') + '/asr/transcribe', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Authorization': 'Bearer ' + env.META_API_KEY,
          },
          body: upstreamForm,
        });
      } catch {
        return json({ error: 'Upstream request failed.' }, 502);
      }
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    return json({ error: 'Not found' }, 404);
  },
};
