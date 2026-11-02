(function (root) {
  'use strict';
  const safeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
  function escape(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function snapshot(record, artwork, W) {
    if (!W.validOutput(record, record.story)) throw Error('No current story');
    if (artwork && (!W.imageAllowed(record) || !safeTypes.has(artwork.type))) throw Error('Invalid artwork');
    return { id: root.crypto.randomUUID(), dayId: record.dayId, revision: record.contentRevision, createdAt: Date.now(),
      lines: record.story.lines.map(l => l.text), question: W.validQuestion(record, record.question) ? record.question.text : '', artwork: artwork || null };
  }
  async function artwork(url) {
    if (!url) return null;
    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error('Could not read artwork');
    const blob = await response.blob();
    if (!safeTypes.has(blob.type) || blob.size > 20 * 1024 * 1024 || blob.size === 0) throw Error('Unsupported artwork');
    const bitmap = await createImageBitmap(blob); bitmap.close(); // Validate actual image bytes, not just MIME.
    return blob;
  }
  function dataURL(blob) {
    if (!blob) return Promise.resolve('');
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
  }
  function html(book, data, language, labels) {
    if (data && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) throw Error('Only embedded raster artwork is allowed');
    const date = new Date(book.createdAt).toLocaleDateString(language);
    // Explicit allowlist: no original memo/photo, review history, testimony, request data or external URLs.
    return '<!doctype html><html lang="' + escape(language) + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">' +
      '<title>Tuck and Whisper</title><style>body{max-width:660px;margin:40px auto;padding:20px;background:#faf7ef;color:#292d35;font:19px/1.8 system-ui}img{width:100%;max-height:70vh;object-fit:contain;border-radius:16px}h1{font-size:28px}aside{font-size:13px;color:#555}blockquote{margin:24px 0;padding:16px;border-left:3px solid #a78951;white-space:pre-wrap}</style></head><body>' +
      '<h1>' + escape(labels.title) + '</h1><p>' + escape(date) + '</p>' + (data ? '<img alt="' + escape(labels.art) + '" src="' + data + '">' : '') +
      book.lines.map(text => '<p>' + escape(text) + '</p>').join('') + (book.question ? '<blockquote>' + escape(book.question) + '</blockquote>' : '') +
      '<aside>' + escape(labels.note) + '</aside></body></html>';
  }
  root.TawBooks = { snapshot, artwork, dataURL, html };
  if (typeof module === 'object') module.exports = root.TawBooks;
})(typeof globalThis === 'object' ? globalThis : this);
