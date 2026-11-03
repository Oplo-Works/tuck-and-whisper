(function (root) {
  'use strict';
  const Workflow = typeof module === 'object' ? require('./workflow.js') : root.TawWorkflow;
  const safeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
  function escape(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  // Read old books without rewriting them or requiring a destructive DB migration.
  function normalize(book) {
    const eventDate = Workflow.validDate(book.eventDate) ? book.eventDate : Workflow.localDate(book.createdAt);
    const pairs = Array.isArray(book.paragraphs) && book.paragraphs.length ? book.paragraphs : [{ lines: book.lines, artwork: null }];
    return Object.assign({}, book, {
      title: typeof book.title === 'string' && book.title.trim() ? book.title.trim() : Workflow.suggestTitle(book.lines, eventDate),
      eventDate, order: Number.isFinite(book.order) ? book.order : book.createdAt,
      paragraphs: pairs.map((p, i) => Object.assign({}, p, { id: p.id || book.id + ':p' + i, order: i,
        artwork: p.artwork || null, artStatus: p.artwork ? 'illustrated' : 'text-only' }))
    });
  }
  function compare(a, b) { return a.eventDate.localeCompare(b.eventDate) || a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id); }
  function snapshot(record, artwork, W, paragraphArtworks) {
    if (!W.validOutput(record, record.story)) throw Error('No current story');
    if (artwork && (!W.imageAllowed(record) || !safeTypes.has(artwork.type))) throw Error('Invalid artwork');
    const arts = Array.isArray(paragraphArtworks) ? paragraphArtworks : [];
    for (const a of arts) if (a && !safeTypes.has(a.type)) throw Error('Invalid paragraph artwork');
    // Paragraph pairs travel with the book: each paragraph keeps its own
    // illustration (or null) so a reopened book restores pairs in order.
    const paragraphs = W.paragraphs(record).map((p, i) => ({ id: record.dayId + ':' + record.contentRevision + ':p' + i,
      order: i, lines: p.lines, artwork: arts[i] || null, artStatus: arts[i] ? 'illustrated' : 'text-only' }));
    return { schemaVersion: 2, ...W.bookMetadata(record), id: root.crypto.randomUUID(), dayId: record.dayId, revision: record.contentRevision, createdAt: Date.now(),
      lines: record.story.lines.map(l => l.text), question: W.validQuestion(record, record.question) ? record.question.text : '', artwork: artwork || null,
      paragraphs };
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
  function html(book, data, language, labels, paragraphData) {
    if (data && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) throw Error('Only embedded raster artwork is allowed');
    const paired = Array.isArray(book.paragraphs) && Array.isArray(paragraphData);
    if (paired) for (const d of paragraphData) if (d && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(d)) throw Error('Only embedded raster artwork is allowed');
    book = normalize(book);
    const date = book.eventDate;
    // Explicit allowlist: no original memo/photo, review history, testimony, request data or external URLs.
    return '<!doctype html><html lang="' + escape(language) + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">' +
      '<title>' + escape(book.title) + '</title><style>body{max-width:660px;margin:40px auto;padding:20px;background:#faf7ef;color:#292d35;font:19px/1.8 system-ui}img{width:100%;max-height:70vh;object-fit:contain;border-radius:16px}h1{font-size:28px}aside{font-size:13px;color:#555}blockquote{margin:24px 0;padding:16px;border-left:3px solid #a78951;white-space:pre-wrap}</style></head><body>' +
      '<h1>' + escape(book.title) + '</h1><p><time datetime="' + date + '">' + date + '</time></p>' + (data ? '<img alt="' + escape(labels.art) + '" src="' + data + '"><aside>' + escape(labels.ai || 'AI illustration') + '</aside>' : '') +
      (paired
        ? book.paragraphs.map((p, i) => '<section data-paragraph-order="' + p.order + '" data-art-status="' + (paragraphData[i] ? 'illustrated' : 'text-only') + '">' + p.lines.map(text => '<p>' + escape(text) + '</p>').join('') +
            (paragraphData[i] ? '<img alt="' + escape(labels.art) + '" src="' + paragraphData[i] + '"><aside>' + escape(labels.ai || 'AI illustration') + '</aside>' : '<aside>' + escape(labels.textOnly || 'Text only') + '</aside>') + '</section>').join('')
        : book.lines.map(text => '<p>' + escape(text) + '</p>').join('')) + (book.question ? '<blockquote>' + escape(book.question) + '</blockquote>' : '') +
      '<aside>' + escape(labels.note) + '</aside></body></html>';
  }
  async function same(a, b) {
    const fields = book => JSON.stringify({ id: book.id, dayId: book.dayId, revision: book.revision, createdAt: book.createdAt,
      submittedAt: book.submittedAt, title: book.title, eventDate: book.eventDate, order: book.order, lines: book.lines, question: book.question,
      paragraphs: book.paragraphs.map(({ artwork, ...p }) => p) });
    if (!a || fields(a) !== fields(b)) return false;
    const aa = [a.artwork, ...a.paragraphs.map(p => p.artwork)], bb = [b.artwork, ...b.paragraphs.map(p => p.artwork)];
    for (let i = 0; i < aa.length; i++) {
      if (!aa[i] && !bb[i]) continue;
      if (!aa[i] || !bb[i] || aa[i].type !== bb[i].type || aa[i].size !== bb[i].size) return false;
      const x = new Uint8Array(await aa[i].arrayBuffer()), y = new Uint8Array(await bb[i].arrayBuffer());
      if (x.some((v, j) => v !== y[j])) return false;
    }
    return true;
  }
  root.TawBooks = { snapshot, normalize, compare, metadata: Workflow.bookMetadata, same, artwork, dataURL, html };
  if (typeof module === 'object') module.exports = root.TawBooks;
})(typeof globalThis === 'object' ? globalThis : this);
