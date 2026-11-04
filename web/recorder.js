/* Local microphone capture only. Transcription remains an explicit app action. */
(function () {
  'use strict';
  const MAX_BYTES = 32 * 1024 * 1024, MAX_MS = 600000;
  let app, session = null, file = null, status = '', elapsed = 0;
  const $ = id => document.getElementById(id);
  const supported = () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof window.MediaRecorder === 'function';
  const busy = () => !!session, clock = s => Math.floor(s / 60).toString().padStart(2, '0') + ':' + (s % 60).toString().padStart(2, '0');
  function render() {
    if (!app) return;
    const active = session?.recorder?.state === 'recording', ready = !!file && !busy();
    $('record-btn').disabled = busy() || app.converting() || !supported();
    $('record-btn').hidden = busy();
    $('stop-recording').hidden = !busy();
    $('stop-recording').textContent = app.t(session && !session.recorder ? 'recordCancel' : 'recordStop');
    $('stop-recording').disabled = !!session?.stopping;
    $('voice-input').disabled = busy();
    $('recording-timer').hidden = !active;
    $('recording-timer').textContent = clock(elapsed) + ' / 10:00'; $('recording-saved').hidden = !ready; $('recording-saved-text').textContent = ready ? app.t('recordSaved', { duration: clock(elapsed) }) : '';
    $('recording-status').textContent = app.t(status || (!supported() ? 'recordUnsupported' : file ? 'recordReady' : ''));
    $('recording-controls').classList.toggle('is-recording', !!active); $('recording-controls').classList.toggle('is-ready', ready); $('recording-status').classList.toggle('is-ready', ready);
  }
  function changed() { render(); app?.changed(); }
  function release(s) {
    clearInterval(s.timer); s.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
  }
  function clear() {
    const s = session; session = null; file = null; status = ''; elapsed = 0;
    if (s) {
      release(s);
      try { if (s.recorder?.state !== 'inactive') s.recorder?.stop(); } catch {}
    }
    render();
  }
  function stop(reason = '') {
    const s = session; if (!s || s.stopping) return;
    if (!s.recorder) { session = null; status = ''; changed(); return; }
    s.stopping = true; s.reason = reason; status = 'recordFinishing';
    clearInterval(s.timer);
    try { if (s.recorder.state !== 'inactive') s.recorder.stop(); }
    catch { s.failed = true; finish(s); }
    release(s); changed();
  }
  function finish(s) {
    release(s); if (session !== s) return;
    const focusNext = document.activeElement === $('stop-recording');
    session = null;
    if (s.failed || !s.size) status = s.failed && s.reason ? s.reason : 'recordFailed';
    else {
      const mime = s.recorder.mimeType || s.chunks[0]?.type || 'audio/mp4';
      const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
      file = new File(s.chunks, 'parent-recording.' + ext, { type: mime });
      elapsed = Math.min(600, Math.max(elapsed, s.started ? Math.max(1, Math.round((Date.now() - s.started) / 1000)) : 1)); status = s.reason || 'recordReady';
    }
    s.chunks = []; changed();
    const next = $('voice-tools')?.open && !$('voice-tools')?.closest('[hidden]') && !document.hidden ? (file ? $('transcribe-btn') : (focusNext ? $('record-btn') : null)) : null; if (next) { next.focus({ preventScroll: true }); const r = next.getBoundingClientRect(), vh = window.visualViewport?.height || window.innerHeight; if (file && (r.bottom > vh || r.top < 0)) next.scrollIntoView({ block: 'nearest' }); }
  }
  async function start() {
    if (busy() || app.converting()) return;
    if (!supported()) { status = 'recordUnsupported'; changed(); return; }
    const s = { chunks: [], size: 0, failed: false }; session = s; status = 'recordPermission'; elapsed = 0; changed();
    $('stop-recording').focus({ preventScroll: true });
    try {
      s.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (session !== s) { release(s); return; }
      const types = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
      const mimeType = types.find(type => window.MediaRecorder.isTypeSupported?.(type));
      s.recorder = new MediaRecorder(s.stream, mimeType ? { mimeType } : undefined);
      s.recorder.ondataavailable = event => {
        if (session !== s || s.failed || !event.data?.size) return;
        if (s.size + event.data.size > MAX_BYTES) {
          s.failed = true; s.reason = 'recordTooLarge'; s.chunks = [];
          if (!s.stopping) stop(s.reason); return;
        }
        s.chunks.push(event.data); s.size += event.data.size;
      };
      s.recorder.onerror = () => { s.failed = true; s.reason = 'recordFailed'; if (!s.stopping) stop(s.reason); finish(s); };
      s.recorder.onstop = () => finish(s);
      s.stream.getTracks().forEach(track => { track.onended = () => stop('recordInterrupted'); });
      s.recorder.start(1000);
      file = null; app.replaced(); s.started = Date.now(); status = 'recordActive';
      s.timer = setInterval(() => {
        elapsed = Math.min(600, Math.floor((Date.now() - s.started) / 1000));
        if (Date.now() - s.started >= MAX_MS) stop('recordLimit'); else render();
      }, 250);
      changed();
    } catch (error) {
      release(s); if (session !== s) return;
      session = null;
      status = error.name === 'NotAllowedError' || error.name === 'SecurityError' ? 'recordDenied' :
        error.name === 'NotFoundError' ? 'recordNoMic' : error.name === 'NotReadableError' ? 'recordMicBusy' :
        error.name === 'NotSupportedError' ? 'recordUnsupported' : 'recordFailed';
      changed();
    }
  }
  function init(context) {
    app = context; $('record-btn').onclick = start; $('stop-recording').onclick = () => stop();
    $('voice-tools').addEventListener('toggle', () => { if (!$('voice-tools').open) stop(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop('recordInterrupted'); });
    window.addEventListener('pagehide', clear); render();
  }
  window.TawRecorder = { init, render, clear, stop, busy, getFile: () => file };
})();
