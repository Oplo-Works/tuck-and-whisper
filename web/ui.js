/* Presentation only: no facts, model calls or book storage are changed here. */
(function () {
  'use strict';
  const paths = {
    settings: ['M4 6h16M4 12h16M4 18h16', 'M8 3v6M16 9v6M10 15v6'],
    moon: ['M20.9 13.3A9 9 0 0 1 10.7 3.1 9 9 0 1 0 20.9 13.3Z'],
    sun: ['M12 3V1M12 23v-2M3 12H1M23 12h-2M4.2 4.2 2.8 2.8M21.2 21.2l-1.4-1.4M4.2 19.8l-1.4 1.4M21.2 2.8l-1.4 1.4', 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0'],
    photo: ['M4 5h16v14H4Z', 'm4 15 5-5 5 6 3-3 3 3', 'M17 8h.01'],
    note: ['M8 3h8l4 4v14H4V3h4Z', 'M8 11h8M8 15h8M8 7h3'],
    voice: ['M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0Z', 'M5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8'],
    check: ['m5 12 4 4L19 6'], cross: ['m6 6 12 12M18 6 6 18'],
    review: ['M8 3h8v4H8Z', 'M8 5H5v16h14V5h-3', 'm8 14 3 3 5-6'],
    book: ['M3 4h7l2 2 2-2h7v16h-7l-2 2-2-2H3Z', 'M12 6v16'],
    library: ['M4 3v18M9 3v18M14 3v18M18 4l4 16'],
    shield: ['m12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5Z', 'm8 12 3 3 5-6'],
    arrow: ['M4 12h16m-6-6 6 6-6 6'], save: ['M4 3h13l3 3v15H4Z', 'M8 3v6h8V3M8 21v-7h8v7'],
    trash: ['M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7'],
    download: ['M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4'],
    talk: ['M4 3h16v14H9l-5 4Z', 'M8 8h8M8 12h5'],
    clock: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', 'M12 7v5l3 2']
  };
  function icon(name) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.65');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.classList.add('ui-icon');
    for (const d of paths[name] || paths.note) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
    svg.dataset.name = name; return svg;
  }
  function decorate(root = document) {
    for (const el of root.querySelectorAll('[data-icon]')) {
      const old = Array.from(el.children).find(child => child.classList.contains('ui-icon'));
      if (old?.dataset.name === el.dataset.icon) continue;
      if (old) old.remove(); el.prepend(icon(el.dataset.icon));
    }
  }
  function render(screen, t) {
    const dusk = document.documentElement.dataset.theme === 'dusk', button = document.getElementById('theme-toggle');
    button.dataset.icon = dusk ? 'sun' : 'moon'; button.querySelector('span').textContent = t(dusk ? 'themePaper' : 'themeDusk');
    button.setAttribute('aria-pressed', String(dusk)); button.setAttribute('aria-label', t(dusk ? 'themePaper' : 'themeDusk'));
    const current = { capture: 'nav-capture', review: 'nav-review', preview: 'nav-preview', bedtime: 'nav-preview', library: 'nav-library' }[screen];
    for (const el of document.querySelectorAll('nav button')) {
      if (el.id === current) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
    }
    document.querySelector('meta[name="theme-color"]').content = dusk ? '#11162d' : '#f5f0e6';
    document.getElementById('settings-open').setAttribute('aria-label', t('settings'));
    document.getElementById('lang-select').setAttribute('aria-label', t('language'));
    const card = document.querySelector('#screen-' + screen + '>.card');
    if (card) {
      const heading = card.querySelector('.section-heading');
      heading.append(document.getElementById('save-status'));
      document.getElementById('save-status').title = t('saved');
      // Keep feedback with the current task, below its heading, not above navigation.
      heading.after(document.getElementById('message'));
    }
    decorate();
    fitQuestion();
  }
  function fitQuestion() {
    const field = document.getElementById('question-text');
    if (!field.getClientRects().length) return;
    field.style.height = 'auto';
    const availableHeight = window.visualViewport?.height || innerHeight;
    field.style.height = Math.min(Math.max(field.scrollHeight + 2, 88), Math.max(120, availableHeight * .4)) + 'px';
  }
  function viewportChanged() {
    const viewport = window.visualViewport;
    const editing = document.activeElement?.matches('input,textarea');
    document.documentElement.classList.toggle('keyboard-open', !!(editing && viewport && viewport.scale === 1 && viewport.height < innerHeight * .75));
    fitQuestion();
  }
  for (const heading of document.querySelectorAll('main>section>.card>h2')) {
    const row = document.createElement('div'); row.className = 'section-heading';
    heading.before(row); row.append(heading);
  }
  document.getElementById('settings-open').onclick = () => document.getElementById('settings-dialog').showModal();
  document.getElementById('settings-dialog').addEventListener('close', () => document.getElementById('settings-open').focus({ preventScroll: true }));
  document.getElementById('question-text').addEventListener('input', fitQuestion);
  window.addEventListener('resize', viewportChanged);
  window.visualViewport?.addEventListener('resize', viewportChanged);
  document.addEventListener('focusin', viewportChanged);
  document.addEventListener('focusout', () => requestAnimationFrame(viewportChanged));
  window.TawUI = { icon, decorate, render };
})();
