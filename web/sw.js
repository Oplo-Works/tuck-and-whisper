// Tuck and Whisper — service worker v11.
// v11 변경: 23개 언어 테이블 추가(i18n.js 25개 언어 완성)가 닿게 CACHE 를 taw-shell-v11 로
//           올린다. activate 에서 옛 캐시(taw-shell-v10 포함)를 전부 삭제한다.
// v9 변경: S8 제한 모드(PHOTO_PROMPT_ONLY 화면)가 닿게 CACHE 를 taw-shell-v9 로 올린다.
//          activate 에서 옛 캐시(taw-shell-v8 포함)를 전부 삭제한다.
// v8 변경: S7-fix(교정 피드백 경계·NFC 누출 검사·소진 ID)가 닿게 CACHE 를 taw-shell-v8 로 올린다.
//          activate 에서 옛 캐시(taw-shell-v7 포함)를 전부 삭제한다.
// v7 변경: 새 하루 확인 단계(라벨 "새 하루 시작" 포함)가 닿게 CACHE 를 taw-shell-v7 로 올린다.
//          activate 에서 옛 캐시(taw-shell-v6 포함)를 전부 삭제한다.
// v6 변경: 프리뷰 진입 가드 강제가 닿게 CACHE 를 taw-shell-v6 로 올린다.
//          activate 에서 옛 캐시(taw-shell-v5 포함)를 전부 삭제한다.
// v5 변경: LEAK 어휘 정정(기뻐 추가)이 닿게 CACHE 를 taw-shell-v5 로 올린다.
//          activate 에서 옛 캐시(taw-shell-v4 포함)를 전부 삭제한다.
// v4 변경: S5(취침 페이지) 이후의 셸을 폰에 강제 갱신하게 CACHE 를 taw-shell-v4 로 올린다.
//          activate 에서 옛 캐시(taw-shell-v3 포함)를 전부 삭제한다.
// v3 변경: S4b(프리뷰 화면) 이후의 셸을 폰에 강제 갱신하게 CACHE 를 taw-shell-v3 로 올린다.
//          activate 에서 옛 캐시(taw-shell-v2 포함)를 전부 삭제한다.
// v2 변경 (브리프: 배포가 폰에 닿게 하는 필수 작업):
// - CACHE 이름을 taw-shell-v2 로 올리고, activate 에서 옛 캐시(taw-shell-v1 포함)를 전부 삭제한다.
// - HTML 문서(페이지 이동 요청)는 network-first: 네트워크에서 먼저 받고, 성공하면 캐시를
//   갱신하고, 실패할 때만 캐시를 내준다 — index.html 을 고치면 폰에 새 배포가 바로 닿는다.
// - 그 외 정적 파일은 기존 방식(cache-first)을 유지한다. API(/api/) 트래픽은 절대 캐시하지 않는다.
const CACHE = 'taw-shell-v11';
// index.html 이 이제 외부 core.js/i18n.js/app.js 에 의존하므로 오프라인 셸에 함께 넣는다.
const SHELL = ['./', './index.html', './core.js', './i18n.js', './app.js', './manifest.json', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.includes('/api/')) return; // never cache API traffic

  // HTML 문서(페이지 이동) — network-first.
  if (e.request.mode === 'navigate' && url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
          }
          return response;
        })
        .catch(() =>
          caches.match(e.request).then((hit) => hit || caches.match('./index.html'))
        )
    );
    return;
  }

  // 그 외 정적 파일 — cache-first (기존 방식 유지)
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
