// Tuck and Whisper — Meta Model API proxy (Cloudflare Worker)
//
// Purpose: the Meta Model API key lives ONLY here, as a Worker secret.
// The PWA calls this Worker; the Worker forwards to the Meta Model API.
//
// Required configuration (Worker Settings → Variables and Secrets):
//   META_API_KEY   (Secret)  — your Meta Model API key
//   META_API_BASE  (Variable, optional) — defaults to https://api.meta.ai/v1
//                               (verified in the official docs at dev.meta.ai/docs/overview)
//
// Routes:
//   GET  /api/health  → { ok: true }
//   POST /api/spark   → forwards the JSON body to {META_API_BASE}/chat/completions
//                       with model "muse-spark-1.3" unless the body overrides it.
//   POST /api/image   → forwards the JSON body to {META_API_BASE}/images/edits
//                       with model "muse-image-1.0" unless the body overrides it
//                       (img2img stylization; body carries images:[{image_url}]).
//   POST /api/voice   → forwards the raw multipart/form-data body to
//                       {META_API_BASE}/asr/transcribe (Muse Voice Transcribe).
//                       Body must be multipart: part "request" (JSON settings:
//                       model "muse-voice-transcribe-1.0", audioEncoding "WAV")
//                       and part "audio" (WAV mono 16-bit PCM, 16k or 24k Hz).
//                       The API accepts WAV only, so the PWA converts phone
//                       recordings (Android m4a etc.) to WAV in the browser
//                       (WebAudio decode → PCM WAV) before upload. Users never
//                       handle formats or conversion themselves.
//
// NOTE: the default base URL (https://api.meta.ai/v1) is taken from the official
// Meta Model API documentation overview; META_API_BASE can override it.

// The Worker URL is public, so /api/spark only accepts browser calls from our
// own Pages site (incl. preview deployments) or local dev servers. This keeps
// strangers from burning the API credit. CLI tests must send an Origin header:
//   -H "Origin: https://tuck-and-whisper.pages.dev"
function originAllowed(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return host === 'tuck-and-whisper.pages.dev'
      || host.endsWith('.tuck-and-whisper.pages.dev')
      || host === 'localhost'
      || host === '127.0.0.1';
  } catch { return false; }
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/api/health') return json({ ok: true });

    if (url.pathname === '/api/spark' && request.method === 'POST') {
      if (!originAllowed(request)) return json({ error: 'Origin not allowed.' }, 403);
      if (!env.META_API_KEY) return json({ error: 'META_API_KEY secret is not set on this Worker.' }, 500);
      const base = env.META_API_BASE || 'https://api.meta.ai/v1';

      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }
      if (!body.model) body.model = 'muse-spark-1.3';

      const upstream = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
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

    if (url.pathname === '/api/image' && request.method === 'POST') {
      if (!originAllowed(request)) return json({ error: 'Origin not allowed.' }, 403);
      if (!env.META_API_KEY) return json({ error: 'META_API_KEY secret is not set on this Worker.' }, 500);
      const base = env.META_API_BASE || 'https://api.meta.ai/v1';

      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }
      if (!body.model) body.model = 'muse-image-1.0';

      const upstream = await fetch(base.replace(/\/$/, '') + '/images/edits', {
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

    if (url.pathname === '/api/voice' && request.method === 'POST') {
      if (!originAllowed(request)) return json({ error: 'Origin not allowed.' }, 403);
      if (!env.META_API_KEY) return json({ error: 'META_API_KEY secret is not set on this Worker.' }, 500);
      const base = env.META_API_BASE || 'https://api.meta.ai/v1';

      // Multipart passthrough: keep the original Content-Type (with boundary)
      // and stream the body through untouched.
      const upstream = await fetch(base.replace(/\/$/, '') + '/asr/transcribe', {
        method: 'POST',
        headers: {
          'Content-Type': request.headers.get('Content-Type') || '',
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + env.META_API_KEY,
        },
        body: request.body,
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
