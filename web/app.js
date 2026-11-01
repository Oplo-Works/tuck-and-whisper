// Tuck & Whisper — 화면 층: Capture / Gate 1 / 확정 목록 + 라이브 Spark 추출 (S2)
// 상태 전이는 전부 core.js(TawCore)의 함수로만 한다. 이 파일은 렌더링·이벤트·Worker 호출을 담당한다.
// 모델이 만든 텍스트는 전부 textContent로 넣는다 (innerHTML 금지). 화면당 렌더 함수 1개.

(function () {
  "use strict";

  const T = window.TawCore;

  // --- i18n (S-i18n): 표시 문자열만 t() 경유 — 프로토콜은 한국어 불변이다 ---
  // i18n.js가 없는 환경(vm 하니스)에서는 하니스가 텍스트로 클릭하는 결정 버튼 라벨만
  // 한국어로 유지한다 (하니스 프로토콜 계약 — 클릭 대상 텍스트가 바뀌면 검증이 깨진다).
  const I = window.TAW_I18N || null;
  const LANG_KEY = "taw-lang"; // taw-day-v1 데이터 계약과 별개 저장
  const PROTOCOL_LABEL_FALLBACK = { "decision.confirm": "확정", "decision.reject": "거절", "decision.undecided": "미결정" };
  function t(key, vars) {
    if (I) return I.t(key, vars);
    return PROTOCOL_LABEL_FALLBACK[key] || key;
  }
  function voiceBias() {
    const info = I ? I.languageInfo(I.getLanguage()) : null;
    return info && info.bias ? info.bias : "Korean";
  }
  function currentLocale() {
    return I ? I.getLanguage() : "ko"; // 증언 시각 등 표시 로케일 — 선택 언어를 따른다
  }

  // 정적(data-i18n) 일괄 교체 + <html lang/dir> 연동 (ar만 rtl).
  function applyI18nStatic() {
    if (!I) return;
    const lang = I.getLanguage();
    const info = I.languageInfo(lang) || { rtl: false };
    if (document.documentElement) {
      document.documentElement.lang = lang;
      document.documentElement.dir = info.rtl ? "rtl" : "ltr";
    }
    if (typeof document.querySelectorAll !== "function") return; // 하니스 DOM — 정적 치환 대상 없음
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      const key = el.getAttribute("data-i18n");
      const v = I.t(key);
      if (v !== key) el.textContent = v; // 없는 키는 원문 유지
    });
    document.querySelectorAll("[data-i18n-ph]").forEach(function (el) {
      const key = el.getAttribute("data-i18n-ph");
      const v = I.t(key);
      if (v !== key) el.setAttribute("placeholder", v);
    });
  }

  function initI18n() {
    if (!I) return;
    const langs = I.languages(); // 테이블에 있는 언어만 노출 — 23개가 들어오면 자동으로 늘어난다
    const select = $("lang-select");
    select.textContent = "";
    for (const l of langs) {
      const opt = document.createElement("option");
      opt.value = l.code;
      opt.textContent = l.name;
      select.appendChild(opt);
    }
    let saved = null;
    try { saved = localStorage.getItem(LANG_KEY); } catch (err) { saved = null; }
    const has = function (code) { return langs.some(function (l) { return l.code === code; }); };
    let lang = saved && has(saved) ? saved : "";
    if (!lang) {
      const nav = String((typeof navigator !== "undefined" && navigator.language) || "");
      const base = nav.split("-")[0];
      lang = has(base) ? base : "en"; // 첫 실행: 브라우저 언어(지원 집합 내) → en
    }
    I.setLanguage(lang);
    select.value = lang;
    applyI18nStatic();
  }

  function onLanguageChange(e) {
    if (!I) return;
    const select = $("lang-select");
    const lang = e && e.target && e.target.value ? e.target.value : select.value;
    I.setLanguage(lang);
    try { localStorage.setItem(LANG_KEY, lang); } catch (err) { /* 저장이 막힌 환경 — 세션만 */ }
    applyI18nStatic();
    // 동적 문자열 재렌더 — 렌더 함수는 전부 t()를 다시 읽는다
    renderCaptureScreen();
    renderGate1Screen();
    renderConfirmedScreen();
    renderPreviewScreen();
    renderBedtimeScreen();
    renderPreviewRestricted();
    renderBedtimeRestricted();
  }

  // Worker 기본 URL — 브리프 v2: "코드 상수로 그대로 쓸 것". API 키는 여기 없다 (Worker Secret에만 있다).
  const WORKER_URL = "https://taw-meta-proxy.minkyuthebuilder.workers.dev";

  // 프로필 상수 (브리프). keywords는 전사 바이어스 전용이다 — 추출 프롬프트는 동결 상태이며
  // 이름 주입 지점이 없고, 추출에서 이름은 메모 텍스트를 통해서만 들어간다.
  const PROFILE = { childName: "신유", keywords: ["들이", "신유"] };

  // 브리프 v2의 동결된 추출 시스템 프롬프트 — 요약·재조립 금지, 한 글자도 바꾸지 마라.
  const SPARK_SYSTEM_PROMPT = `너는 부모가 아이와 보낸 하루의 사진과 메모에서 '사실 후보'를 추출하는 도구다.
규칙:
- 사진에서 직접 관찰 가능한 것과 메모에 진술된 것만 후보로 만든다. 추측·서사·감정 단정은 금지.
- 각 후보에 출처(source: "photo"|"memo")와 등급(grade)을 붙인다. 등급: 직접 관찰/단순 진술은 "C", 행동·감정·원인·의도에 관한 진술은 "B" (부모 개별 확인 대상).
- 사진으로 단정할 수 없는 것(견종, 성별, 소유 관계, 아이의 기분 등)은 후보로 만들지 말고 unknowns에 질문형으로 넣는다.
- 아이와 동물의 상호작용 — 시선 교환, 올려다봄/내려다봄, 신체 접촉, 몸의 방향 — 도 관찰 후보로 빠짐없이 포함한다.
- 출력은 JSON만: {"candidates":[{"text":"...","source":"photo|memo","grade":"B|C"}],"unknowns":["..."]}`;

  // 브리핑 합성 시스템 프롬프트 (S4 패킷 동결 — 그대로 쓸 것).
  const BRIEFING_SYSTEM_PROMPT = "너는 부모를 위한 취침 전 브리핑 작성자다. 입력은 부모가 확정한 사실 목록뿐이다(id와 text). 규칙: 1) 입력에 없는 사실·감정·원인·인물을 만들지 마라. 2) 모든 문장은 근거가 된 사실의 id를 factIds에 인용해라. 인용 없는 문장은 금지. 3) 문장은 짧고 담백하게 — 사실을 전하는 것만 해라. 4) 출력은 JSON만: {\"lines\":[{\"text\":\"...\",\"factIds\":[\"F1\"]}]}";

  // 질문 카드 초안 시스템 프롬프트 (패킷에 동결문이 없어 브리핑 프롬프트와 같은 원칙으로 작성 — 가정 목록 참조).
  const QUESTION_SYSTEM_PROMPT = "너는 부모가 아이에게 물어볼 취침 질문 카드 작성자다. 입력은 아직 알 수 없는 질문(unknown) 하나와 그 전제가 되는 확정 사실 목록(id와 text)이다. 규칙: 1) 입력에 없는 사실·감정·인물을 만들지 마라. 2) unknown을 아이에게 물기 좋은 짧은 한 문장으로 다듬어라. 3) 확정 사실을 다시 설명하지 마라. 4) 출력은 JSON만: {\"text\":\"...\"}";

  // 페이지 문장 합성 시스템 프롬프트 (S5 패킷 동결 — 그대로 쓸 것).
  const PAGE_SYSTEM_PROMPT = "너는 아이에게 읽어 줄 취침 그림책 페이지의 문장을 쓰는 작가다. 입력은 부모가 확정한 사실 목록뿐이다(id와 text). 규칙: 1) 입력에 없는 사실·감정·원인·인물·대사를 만들지 마라. 2) 모든 문장은 근거가 된 사실의 id를 factIds에 인용해라. 인용 없는 문장은 금지. 3) 문장은 짧고 따뜻하게, 아이가 듣고 따라 할 수 있는 쉬운 말로 — 사실의 내용은 바꾸지 말고 어미와 리듬만 다듬어라. 4) 4~7문장. 5) 출력은 JSON만: {\"sentences\":[{\"text\":\"...\",\"factIds\":[\"F1\"]}]}";

  // 스타일화 프롬프트 (S5 패킷 동결 — 스파이크 2 실증문에서 주어만 일반화). 절대 바꾸지 마라.
  const IMAGE_PROMPT = "Restyle this photo as a warm picture-book illustration for a children's bedtime story. Keep the same child and the same subjects, with their faces recognizable as the same individuals, the same pose and the same composition. Do not add or remove any person, animal, or object. Soft watercolor storybook style.";
  // 이미지 모델 id는 문서화돼 있지 않아 스파이크 계열 명명 규칙으로 추정했다 (가정 목록 참조).
  const IMAGE_MODEL = "muse-image-1.0";

  // 브리프의 스파이크 실제 출력 그대로 — 등급을 임의로 고치지 않는다 (F11~F13의 B 포함).
  const SAMPLE_DAY = {
    child: { name: "신유", age: 7 },
    memo: {
      text: "한국 할아버지 집에서, 태어난 지 한 달 된 강아지 들이랑 밭길에서 놀았어. 들이가 신유를 졸졸 따라다녔고, 신유가 들이를 안아주기도 했어."
    },
    candidates: [
      { id: "F1", text: "줄무늬 티셔츠와 반바지를 입은 아이가 풀밭 사이의 길 위에 서 있다", source: "photo", grade: "C" },
      { id: "F2", text: "밝은 색의 작은 강아지 한 마리가 아이의 다리 바로 옆에 있다", source: "photo", grade: "C" },
      { id: "F3", text: "아이는 상체를 앞으로 숙이고 몸이 강아지 쪽을 향해 있다", source: "photo", grade: "C" },
      { id: "F4", text: "아이가 아래쪽 강아지를 내려다보고 있다", source: "photo", grade: "C" },
      { id: "F5", text: "강아지가 아이를 올려다보고 있다", source: "photo", grade: "C" },
      { id: "F6", text: "강아지의 코/입 부위가 아이의 무릎 근처에 닿아 있다", source: "photo", grade: "C" },
      { id: "F7", text: "한국 할아버지 집에서 놀았다", source: "memo", grade: "C" },
      { id: "F8", text: "강아지의 이름은 '들이'이다", source: "memo", grade: "C" },
      { id: "F9", text: "아이의 이름은 '신유'이다", source: "memo", grade: "C" },
      { id: "F10", text: "강아지는 태어난 지 한 달 되었다", source: "memo", grade: "C" },
      { id: "F11", text: "밭길에서 놀았다", source: "memo", grade: "B" },
      { id: "F12", text: "들이가 신유를 졸졸 따라다녔다", source: "memo", grade: "B" },
      { id: "F13", text: "신유가 들이를 안아주었다", source: "memo", grade: "B" }
    ],
    unknowns: [
      { id: "U1", text: "강아지의 견종은 무엇인가?" },
      { id: "U2", text: "강아지의 성별은 무엇인가?" },
      { id: "U3", text: "강아지와 할아버지 집의 관계(소유 여부)는 무엇인가?" },
      { id: "U4", text: "사진에서 아이의 표정이나 기분은 확인할 수 있는가?" },
      { id: "U5", text: "들이는 지금 얼마나 컸을까?" }
    ]
  };

  // --- 상태 (모듈 변수가 전부다) ---
  let record = T.createDayRecord(); // 모든 전이는 core 함수로만
  let photoFile = null;             // 세션 전용 File — serialize 화이트리스트 밖, 절대 저장 안 됨
  let photoUrl = null;              // 세션 전용 객체 URL (Gate 1 썸네일) — 저장 안 됨
  let extracting = false;           // 이중 제출 금지 — 실행 중에는 버튼이 비활성된다
  let lastDebugText = "";           // 형식 깨진 항목(debug) — 세션 전용, 텍스트로만 표시한다
  let voiceFile = null;             // 세션 전용 녹음 File (m4a 그대로) — 저장 안 됨
  let transcribing = false;         // 음성 전사 진행 중 — extracting과 독립 (S2 경로와 격리)
  let synthesizing = false;         // 브리핑 합성 진행 중 (S4)
  let questionDrafting = false;     // 질문 초안 작성 진행 중 (S4)
  let previewError = "";            // 프리뷰 화면 오류 — 세션 전용
  let briefingFallbackNotice = false; // 폴백 안내 표시 여부 — 세션 전용 (저장 안 함)
  let premiseSelection = [];        // 질문 카드 전제 사실 선택 — 세션 전용
  let selectedUnknownId = "";       // 질문 카드 unknown 선택 — 세션 전용 (기본값: 마지막 unknown)
  let previewRawSnippet = "";       // 합성 실패 시 모델 원문 스니펫 — 세션 전용 디버그
  let photoDataUrl = null;          // 세션 전용 추출용 data URL (스타일화 재사용) — 저장 절대 금지
  let pageSynthesizing = false;     // 페이지 문장 합성 진행 중 (S5)
  let pageFallbackNotice = false;   // 페이지 폴백 안내 — 세션 전용
  let pageError = "";               // 취침 화면 오류 — 세션 전용
  let pageRawSnippet = "";          // 페이지 합성 실패 원문 스니펫 — 세션 전용
  let stylizing = false;            // 스타일화 진행 중 (S5)
  let styleImageUrl = null;         // 스타일화 결과 — 세션 표시 전용 (레코드에 넣지 않는다)
  let styleError = "";              // 스타일화 오류 — 세션 전용
  let styleRawSnippet = "";         // 스타일화 실패 원문 스니펫 — 세션 전용
  let burnedFactIds = new Set();    // 무효화로 소진된 구 세대 후보 ID — 재추출이 재사용하지 않게 (S7-fix A3)
  // 무효화 epoch (DS-1 P0-1): 입력 변경·결정 변경·새 하루·샘플 전환처럼 세션 자체를
  // 무효화하는 사건에서만 증가한다. 증언 저장·합성 적용 같은 독립 작업의 정상적인
  // record 교체는 epoch를 건드리지 않으므로 서로의 결과를 폐기하지 않는다.
  let invalidationEpoch = 0;

  function $(id) { return document.getElementById(id); }

  // --- 화면 전환 (단일 헬퍼) ---
  const SCREENS = ["screen-capture", "screen-gate1", "screen-confirmed", "screen-preview", "screen-preview-restricted", "screen-bedtime", "screen-bedtime-restricted"];
  function showScreen(id) {
    for (const sid of SCREENS) {
      $(sid).hidden = sid !== id;
    }
    window.scrollTo(0, 0);
  }

  // --- 저장/복원 — core serialize/restore + core.STORAGE_KEY 만 사용 (사진·base64는 닿지 않는다) ---
  function persist() {
    try {
      const json = T.serialize(record);
      if (json === null) {
        localStorage.removeItem(T.STORAGE_KEY);
      } else {
        localStorage.setItem(T.STORAGE_KEY, json);
      }
    } catch (err) {
      // 저장이 막힌 환경(시크릿 모드 등)에서도 화면 동작은 계속된다.
    }
  }

  // --- 공용 DOM 조각 ---
  function makeChip(text, className) {
    const span = document.createElement("span");
    span.className = "chip" + (className ? " " + className : "");
    span.textContent = text;
    return span;
  }

  function decisionLabel(decision) {
    if (decision === "confirmed") return t("decision.confirm");
    if (decision === "rejected") return t("decision.reject");
    return t("decision.undecided");
  }

  function makePhotoPlaceholder(text) {
    const div = document.createElement("div");
    div.className = "photo-placeholder";
    div.textContent = text;
    return div;
  }

  // ---------------------------------------------------------------
  // Capture 화면
  // ---------------------------------------------------------------

  function renderCaptureScreen() {
    $("memo-input").value = record.memoText;
    $("photo-status").textContent = photoFile
      ? t("capture.selectedPhoto", { name: photoFile.name })
      : "";
    updateExtractButton();
    updateVoiceButton();
    // 추출 결과가 남아 있는 상태로 Capture에 돌아왔으면 검토 계속 버튼을 보여준다
    $("back-to-gate1-btn").hidden = record.candidates.length === 0;
  }

  function updateExtractButton() {
    // 브리프: 사진과 메모가 모두 있을 때만 활성화 (실행 중에는 setExtractRunning이 잠근다)
    const hasPhoto = photoFile !== null;
    const hasMemo = $("memo-input").value.trim() !== "";
    $("extract-btn").disabled = extracting || !(hasPhoto && hasMemo);
  }

  function setExtractRunning(running) {
    const btn = $("extract-btn");
    btn.textContent = running ? t("capture.extracting") : t("capture.extract");
    btn.disabled = running;
  }

  function invalidatePendingWork() {
    invalidationEpoch += 1;
    // 무효화된 요청을 기다리지 않고 새 입력으로 재시도할 수 있다.
    // 각 요청의 finally도 epoch를 확인해 새 작업의 실행 상태를 건드리지 않는다.
    extracting = false;
    synthesizing = false;
    questionDrafting = false;
    pageSynthesizing = false;
    stylizing = false;
    setExtractRunning(false);
    updateExtractButton();
  }

  // 무효화 규칙: 사진/메모가 바뀌면 무효화 epoch를 올려 진행 중 작업을 전부 폐기하고,
  // 추출 결과가 있으면 비운다. 후보가 0개여도 레코드는 새 객체로 교체한다 —
  // 진행 중 추출의 토큰(record 결합)도 함께 무효가 되어야 하기 때문이다 (DS-1 P0-2b).
  function invalidateForChangedInput(message) {
    invalidatePendingWork();
    if (record.candidates.length > 0 || record.unknowns.length > 0) {
      for (const c of record.candidates) {
        if (c && typeof c.id === "string") burnedFactIds.add(c.id); // 소진 ID 등록 (S7-fix A3)
      }
      record = Object.assign(T.invalidateExtraction(record), { memoText: $("memo-input").value });
      lastDebugText = "";
      $("capture-notice").textContent = message;
      $("capture-notice").hidden = false;
      $("back-to-gate1-btn").hidden = true;
    } else {
      // 후보가 없어도 새 record 객체로 교체해 진행 중 추출 토큰을 무효화한다.
      record = Object.assign({}, record, { memoText: $("memo-input").value });
    }
    persist();
  }

  function onMemoInput() {
    invalidateForChangedInput(t("capture.invalidatedMemo"));
    updateExtractButton();
  }

  function onPhotoChange() {
    const file = $("photo-input").files && $("photo-input").files[0] ? $("photo-input").files[0] : null;
    if (file === photoFile) return;
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl);
      photoUrl = null;
    }
    photoFile = file;
    if (photoFile) {
      photoUrl = URL.createObjectURL(photoFile); // 세션 전용 썸네일용 — 저장 금지
    }
    // 구 사진의 파생 세션 상태를 전부 폐기한다 (DS-1 P0-2a) — 새 사진의 취침 페이지에
    // 이전 스타일화 그림/오류가 남지 않게 한다. data URL도 새 추출 전까지 비운다.
    if (photoDataUrl) photoDataUrl = null;
    if (styleImageUrl) {
      URL.revokeObjectURL(styleImageUrl);
      styleImageUrl = null;
    }
    styleError = "";
    styleRawSnippet = "";
    invalidateForChangedInput(t("capture.invalidatedPhoto"));
    renderCaptureScreen();
  }

  // ---------------------------------------------------------------
  // 라이브 Spark 추출 (브리프 v2 API 계약 그대로)
  // ---------------------------------------------------------------

  // 사진 전송 전 처리 (브리프): 긴 변 ≤1568px 축소, JPEG 0.85 재인코딩, base64 data URL.
  // data URL은 요청 본문에 한 번 쓰이고 버려진다 — 어디에도 저장되지 않는다.
  async function preparePhoto(file) {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > 1568 ? 1568 / longest : 1;
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.85);
  }

  // 코드펜스(```)가 붙어 있으면 벗긴다 (브리프: 파싱 전에 벗긴다).
  function stripCodeFence(text) {
    let t = text.trim();
    if (t.startsWith("```")) {
      t = t.replace(/^```[a-zA-Z]*\r?\n?/, "").replace(/```\s*$/, "").trim();
    }
    return t;
  }

  // 모델 응답용 완화 파싱: 직접 파싱이 실패하면 본문에서 첫 { 부터 마지막 } 까지
  // 잘라 다시 시도한다 (앞뒤 잡텍스트만 문제일 때 복구한다). 그래도 실패하면 원문 스니펫을
  // 에러에 붙여 디버그 영역으로 보낸다.
  function parseModelJson(text, what) {
    const stripped = stripCodeFence(text);
    try {
      return JSON.parse(stripped);
    } catch (firstErr) {
      const start = stripped.indexOf("{");
      const end = stripped.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(stripped.slice(start, end + 1));
        } catch (secondErr) { /* 아래에서 원문과 함께 실패 처리 */ }
      }
      const err = new Error(t("error.cannotReadJson", { what: what }));
      err.rawSnippet = stripped.slice(0, 400);
      throw err;
    }
  }

  // choices[0].message.content → 펜스 제거 → JSON.parse → 구조 검증 (candidates 배열).
  function parseSparkContent(content) {
    const raw = JSON.parse(stripCodeFence(content));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.candidates)) {
      throw new Error(t("error.badShapeCandidates"));
    }
    return raw;
  }

  async function runExtraction() {
    if (extracting) return; // 이중 제출 금지
    if (!photoFile || $("memo-input").value.trim() === "") return;

    extracting = true;
    hideCaptureError();
    setExtractRunning(true);

    const token = T.beginExtraction(record); // 시작 시 현재 레코드에 토큰 발급
    const epoch = invalidationEpoch; // 무효화 사건 감지용 — 독립 작업의 record 교체는 무시한다
    let rawText = "";
    try {
      const dataUrl = await preparePhoto(photoFile);
      // 사진 처리 중 사진이 교체됐으면 구 사진의 data URL을 세션에 남기지 않는다.
      if (invalidationEpoch !== epoch) return;
      photoDataUrl = dataUrl; // 세션 전용 보관 — 스타일화에서 재사용, 저장은 절대 안 한다
      const response = await fetch(WORKER_URL + "/api/spark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "muse-spark-1.3",
          reasoning_effort: "low",
          messages: [
            { role: "system", content: SPARK_SYSTEM_PROMPT },
            { role: "user", content: [
              { type: "text", text: "부모 메모: " + token.record.memoText },
              { type: "image_url", image_url: { url: dataUrl } }
            ]}
          ]
        })
      });
      rawText = await response.text();
      if (!response.ok) {
        throw new Error(t("error.workerHttp", { status: response.status }));
      }
      let payload;
      try {
        payload = JSON.parse(rawText);
      } catch (err) {
        throw new Error(t("error.notJson"));
      }
      const content = payload && payload.choices && payload.choices[0] &&
        payload.choices[0].message ? payload.choices[0].message.content : undefined;
    if (typeof content !== "string") {
      throw new Error(t("error.noContent"));
    }
    const raw = parseSparkContent(content);

      // 늦은 응답 가드: 무효화 사건(입력/결정/새 하루/샘플 전환)이 있었으면 조용히 버린다.
      // 독립 작업이 레코드를 교체했을 뿐이면(같은 epoch) 현재 레코드 위에 적용한다.
      if (invalidationEpoch !== epoch) return;
      const applyToken = record === token.record ? token : T.beginExtraction(record);
      record = T.applyExtraction(record, applyToken, raw, burnedFactIds);
      const debug = T.normalizeSpark(raw, burnedFactIds).debug; // 형식 깨진 항목 — 디버그 영역용 (적용과 같은 소진 집합)
      lastDebugText = debug.length > 0 ? JSON.stringify(debug, null, 2) : "";
      persist();
      if (record.candidates.length === 0) {
        // 형식은 맞지만 확정 가능한 후보가 0개 — 무효한 추출로는 Gate 1에 진입하지 않는다.
        showCaptureError(t("capture.noCandidates"), rawText);
        return;
      }
      renderGate1Screen();
      showScreen("screen-gate1");
    } catch (err) {
      // 실패 계약: 오류 배너 + 입력(사진·메모) 유지 + 재시도 가능.
      if (invalidationEpoch !== epoch) return; // 이미 무효화된 세션 — 늦은 실패는 소음이 된다
      showCaptureError(
        t("capture.extractFailed", { message: err && err.message ? err.message : t("error.unknown") }),
        rawText
      );
    } finally {
      if (invalidationEpoch === epoch) {
        extracting = false;
        setExtractRunning(false);
        updateExtractButton();
      }
    }
  }

  function showCaptureError(message, rawText) {
    $("capture-error").textContent = message;
    $("capture-error").hidden = false;
    // 원문 응답은 텍스트로만 (HTML 해석 금지)
    $("debug-raw").textContent = t("debug.errorHeader") + "\n" + message +
      "\n\n" + t("debug.rawHeader") + "\n" + (rawText !== "" ? rawText : t("debug.none"));
    $("debug-details").hidden = false;
  }

  function hideCaptureError() {
    $("capture-error").hidden = true;
    $("capture-error").textContent = "";
    $("debug-details").hidden = true;
    $("debug-raw").textContent = "";
  }

  // ---------------------------------------------------------------
  // 음성 메모 전사 (브리프 단계 3 — 독립 모듈)
  // 이 섹션이 실패해도 위의 텍스트 추출 경로(S2)는 아무 영향받지 않는다.
  // 상태는 voiceFile/transcribing 두 개뿐이고, extract 경로와 코드·플래그가 분리되어 있다.
  // ---------------------------------------------------------------

  function onVoiceChange() {
    const input = $("voice-input");
    voiceFile = input.files && input.files[0] ? input.files[0] : null;
    $("voice-status").textContent = voiceFile
      ? t("capture.selectedRecording", { name: voiceFile.name, mb: (voiceFile.size / 1024 / 1024).toFixed(1) }) +
        (voiceFile.size > 32 * 1024 * 1024 ? t("capture.overSize") : "")
      : "";
    updateVoiceButton();
  }

  function updateVoiceButton() {
    $("transcribe-btn").disabled = transcribing || !voiceFile;
  }

  function setVoiceRunning(running) {
    const btn = $("transcribe-btn");
    btn.textContent = running ? t("capture.transcribing") : t("capture.transcribe");
    btn.disabled = running;
  }

  // 디코드 없이 메타데이터로 길이를 얕게 읽는다 (실패해도 NaN — 디코드 후 권위 재검사가 있다).
  function peekAudioDurationSeconds(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const audio = document.createElement("audio");
      const done = (value) => {
        URL.revokeObjectURL(url);
        resolve(value);
      };
      audio.preload = "metadata";
      audio.onloadedmetadata = function () { done(audio.duration); };
      audio.onerror = function () { done(NaN); };
      setTimeout(function () { done(NaN); }, 4000);
      audio.src = url;
    });
  }

  function durationMessage(seconds) {
    const minutes = Math.round(seconds / 60 * 10) / 10;
    return t("capture.durationOver", { minutes: minutes });
  }

  function limitError(message) {
    const err = new Error(message);
    err.name = "AudioLimitError";
    return err;
  }

  // 독립 음성 함수 (브리프): file → decodeAudioData → OfflineAudioContext로 mono 24kHz
  // 리샘플 → 16-bit PCM WAV Blob. 브라우저가 m4a(AAC)를 그대로 디코딩한다 — 사용자에게
  // 변환을 요구하지 않는다. 길이 제한은 리샘플/인코딩 전에 검사한다.
  async function audioFileToWav(file) {
    const bytes = await file.arrayBuffer();
    const decodeCtx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try {
      decoded = await decodeCtx.decodeAudioData(bytes);
    } finally {
      decodeCtx.close();
    }
    if (decoded.duration > 600) {
      throw limitError(durationMessage(decoded.duration));
    }
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 24000)), 24000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav16(rendered.getChannelData(0), 24000);
  }

  // mono 16-bit PCM WAV 인코더 (RIFF 헤더 44바이트 + little-endian 샘플).
  function encodeWav16(samples, sampleRate) {
    const dataSize = samples.length * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeAscii = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);          // fmt 청크 크기
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, 1, true);           // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // bits per sample
    writeAscii(36, "data");
    view.setUint32(40, dataSize, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  async function runTranscription() {
    if (transcribing || !voiceFile) return;
    const file = voiceFile;

    // 제한 (브리프): 변환·업로드 전에 거부하고 안내한다.
    if (file.size > 32 * 1024 * 1024) {
      showCaptureError(
        t("capture.fileTooLarge", { mb: (file.size / 1024 / 1024).toFixed(1) }),
        ""
      );
      return;
    }
    const peeked = await peekAudioDurationSeconds(file);
    if (isFinite(peeked) && peeked > 600) {
      showCaptureError(durationMessage(peeked), "");
      return;
    }

    transcribing = true;
    setVoiceRunning(true);
    hideCaptureError(); // 재시도 시 이전 실패 배너를 소거한다 (P2-3)
    $("voice-status").textContent = t("capture.transcribingLong");
    try {
      // 1) 변환 — 독립 함수. 디코딩 실패 시 브리프 문구 그대로, 메모 칸은 그대로.
      let wavBlob;
      try {
        wavBlob = await audioFileToWav(file);
      } catch (err) {
        if (err && err.name === "AudioLimitError") {
          showCaptureError(err.message, "");
        } else {
          showCaptureError(
            t("capture.cannotConvert", { message: err && err.message ? err.message : t("error.unknown") }),
            ""
          );
        }
        $("voice-status").textContent = ""; // 실패 — "전사 중…" 고착 해제 (P2-3)
        return;
      }

      // 2) 업로드 — multipart를 정확히 이 형태로 조립한다. Content-Type은 절대 직접 설정하지 않는다
      //    (브라우저가 boundary를 포함해 설정한다).
      const requestData = {
        model: "muse-voice-transcribe-1.0",
        audioEncoding: "WAV",
        mode: "PUSH_TO_TALK",
        languageBias: [voiceBias()], // 선택 언어의 전체 영어 이름 (예: "Spanish") — 키워드는 불변
        keywords: PROFILE.keywords
      };
      const fd = new FormData();
      fd.append('request', new Blob([JSON.stringify(requestData)], { type: 'application/json' }), 'request.json');
      fd.append('audio', wavBlob, 'audio.wav');
      const response = await fetch(WORKER_URL + "/api/voice", { method: "POST", body: fd });
      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(t("error.workerHttp", { status: response.status }));
      }
      let payload;
      try {
        payload = JSON.parse(rawText);
      } catch (err) {
        throw new Error(t("error.notJson"));
      }
      const transcript = payload && payload.transcript;
      if (typeof transcript !== "string" || transcript.trim() === "") {
        throw new Error(t("error.noTranscript"));
      }

      // 3) 성공 — 응답의 transcript로 메모 칸을 교체한다 (이어 붙이지 않는다).
      //    메모 교체 = 메모 수정 — 기존 무효화 규칙을 그대로 탄다 (후보가 있으면 전부 비워진다).
      $("memo-input").value = transcript;
      onMemoInput();
      hideCaptureError(); // 성공 — 이전 실패 배너를 소거한다 (P2-3)
      $("voice-status").textContent = t("capture.transcribeDone");
    } catch (err) {
      // 실패 계약 (S2와 동일): 배너 + 입력 유지 + 재시도 가능
      $("voice-status").textContent = ""; // 실패 — "전사 중…" 고착 해제 (P2-3)
      showCaptureError(
        t("capture.transcribeFailed", { message: err && err.message ? err.message : t("error.unknown") }),
        ""
      );
    } finally {
      transcribing = false;
      setVoiceRunning(false);
    }
  }

  // ---------------------------------------------------------------
  // Gate 1 화면
  // ---------------------------------------------------------------

  function renderGate1Screen() {
    // 상단: 모드 / 사진 영역 / 읽기 전용 메모
    $("gate1-mode").textContent = record.mode === "sample" ? t("mode.sample") : t("mode.live");
    const photoArea = $("gate1-photo-area");
    photoArea.textContent = "";
    if (record.mode === "sample") {
      // 샘플에 임의 사진을 붙이지 않는다 — 거짓 출처 연관 방지 (브리프)
      photoArea.appendChild(makePhotoPlaceholder(t("photo.sampleNone")));
    } else if (photoUrl) {
      const img = document.createElement("img");
      img.className = "photo-thumb";
      img.alt = t("photo.alt");
      img.src = photoUrl; // 세션 객체 URL — 절대 저장되지 않는다
      photoArea.appendChild(img);
    } else {
      photoArea.appendChild(makePhotoPlaceholder(t("photo.noSaved")));
    }
    $("gate1-memo").textContent = record.memoText !== "" ? record.memoText : t("memo.none");

    // 상태 줄 + 컨트롤
    const undecidedCount = record.candidates.filter(function (c) {
      return c.decision === "undecided";
    }).length;
    const undecidedC = record.candidates.filter(function (c) {
      return c.grade === "C" && c.decision === "undecided";
    });
    const complete = T.gate1Complete(record);

    $("gate1-status").textContent = record.candidates.length === 0
      ? ""
      : (complete ? t("gate1.allDecided") : t("gate1.remaining", { n: undecidedCount }));
    const batchBtn = $("batch-confirm-btn");
    batchBtn.hidden = undecidedC.length === 0;
    batchBtn.textContent = t("gate1.batchConfirm", { n: undecidedC.length });
    // S8: 확정 목록 화면은 항상 열려 있다 — 프리뷰 경계는 enterPreview 의 분기가 담당한다.
    $("goto-confirmed-btn").disabled = false;
    $("gate1-empty").hidden = record.candidates.length !== 0;

    // 후보 카드
    const list = $("candidate-list");
    list.textContent = "";
    for (const candidate of record.candidates) {
      list.appendChild(makeCandidateCard(candidate));
    }

    // Unknowns — 읽기 전용 (확정 대상 아님)
    const ul = $("unknown-list");
    ul.textContent = "";
    for (const u of record.unknowns) {
      const li = document.createElement("li");
      li.textContent = u.text;
      ul.appendChild(li);
    }
    $("unknown-section").hidden = record.unknowns.length === 0;

    // 디버그 — 형식 깨진 항목은 텍스트로만 표시한다 (HTML 해석 금지)
    const gateDbg = $("gate1-debug");
    if (lastDebugText !== "") {
      $("gate1-debug-body").textContent = lastDebugText;
      gateDbg.hidden = false;
    } else {
      $("gate1-debug-body").textContent = "";
      gateDbg.hidden = true;
    }
  }

  // 후보 카드: 문장 + 출처 칩 + 등급 칩 + 결정 칩 + 확정/거절 버튼 (개별 탭).
  // B 카드는 강조 스타일 — 일괄 확정 대상에서 절대 제외다 (batchConfirmC 참조).
  function makeCandidateCard(candidate) {
    const card = document.createElement("div");
    card.className = "candidate-card" + (candidate.grade === "B" ? " grade-b" : "");

    const text = document.createElement("p");
    text.className = "candidate-text";
    text.textContent = candidate.text; // 모델 텍스트 — textContent로만 넣는다
    card.appendChild(text);

    const chips = document.createElement("div");
    chips.className = "chips";
    chips.appendChild(makeChip(candidate.source, "chip-source"));
    chips.appendChild(makeChip(candidate.grade, candidate.grade === "B" ? "chip-grade-b" : ""));
    chips.appendChild(makeChip(decisionLabel(candidate.decision),
      candidate.decision === "confirmed" ? "chip-confirmed" :
      candidate.decision === "rejected" ? "chip-rejected" : ""));
    card.appendChild(chips);

    const row = document.createElement("div");
    row.className = "card-buttons";
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = t("decision.confirm");
    confirmBtn.addEventListener("click", function () {
      applyDecision(candidate.id, "confirmed");
    });
    const rejectBtn = document.createElement("button");
    rejectBtn.textContent = t("decision.reject");
    rejectBtn.addEventListener("click", function () {
      applyDecision(candidate.id, "rejected");
    });
    row.appendChild(confirmBtn);
    row.appendChild(rejectBtn);
    card.appendChild(row);
    return card;
  }

  function applyDecision(candidateId, decision) {
    const current = record.candidates.find(function (c) { return c.id === candidateId; });
    if (current && current.decision === decision) return;
    const next = T.setDecision(record, candidateId, decision); // 유일한 전이 경로
    invalidatePendingWork(); // 결정 변경은 진행 중 작업을 전부 폐기하는 무효화 사건
    record = next;
    persist();
    renderGate1Screen();
  }

  // 일괄 확정 — 등급 C만. 이 화면은 후보 문장을 항상 전체로 보여준다(축약 없음)므로
  // "전체 문장을 보여준 상태" 조건이 항상 충족된다. B는 개별 탭으로만 확정된다.
  function batchConfirmC() {
    const targets = record.candidates.filter(function (c) {
      return c.grade === "C" && c.decision === "undecided";
    });
    if (targets.length === 0) return;
    let next = record;
    for (const c of targets) {
      next = T.setDecision(next, c.id, "confirmed");
    }
    invalidatePendingWork(); // 결정 변경 — 진행 중 작업 전부 폐기
    record = next;
    persist();
    renderGate1Screen();
  }

  // ---------------------------------------------------------------
  // 확정 목록 화면
  // ---------------------------------------------------------------

  function renderConfirmedScreen() {
    const facts = T.confirmedFacts(record); // 항상 core 파생 — 저장하지 않음
    const rejectedCount = record.candidates.filter(function (c) {
      return c.decision === "rejected";
    }).length;
    $("confirmed-count").textContent = t("confirmed.count", { confirmed: facts.length, rejected: rejectedCount });

    const list = $("confirmed-list");
    list.textContent = "";
    for (const fact of facts) {
      const li = document.createElement("li");
      li.className = "confirmed-item";
      const text = document.createElement("p");
      text.className = "candidate-text";
      text.textContent = fact.text; // 모델 텍스트 — textContent로만
      li.appendChild(text);
      const chips = document.createElement("div");
      chips.className = "chips";
      chips.appendChild(makeChip(fact.source, "chip-source"));
      chips.appendChild(makeChip(fact.grade, fact.grade === "B" ? "chip-grade-b" : ""));
      li.appendChild(chips);
      list.appendChild(li);
    }
    $("confirmed-empty").hidden = facts.length !== 0;
    // S8: 프리뷰 진입은 항상 가능 — enterPreview 의 분기(CONFIRMED_BRIEF/제한 모드)가 경계다.
    $("open-preview-btn").disabled = false;
  }

  // ---------------------------------------------------------------
  // 제한 모드 (S8, PHOTO_PROMPT_ONLY) — 게이트 1이 마감까지 완료되지 않은 밤.
  // 브리핑·unknowns 질문 카드·페이지 문장·스타일화·메모 원문은 절대 없다 — 합성 호출
  // 자체가 없다 (이 모드에서 Worker 합성 요청이 나가면 그 자체가 실패다). 상태는
  // 파생값(T.outputMode)으로만 계산되고 아무것도 저장하지 않는다 — 게이트 1이
  // 완료되면 다음 진입부터 일반 프리뷰가 자동으로 대체한다 (대체 규칙).
  // ---------------------------------------------------------------

  // 일반 회상 질문 고정 풀: 미확정 후보·unknowns를 어떤 형태로도 참조하지 않는
  // 중립 문장만. 모델 생성 금지 — i18n 테이블의 언어별 6문장(restricted.q1~q6)이 유일한 질문원.
  const GENERIC_QUESTION_COUNT = 6;

  // 로컬 날짜 기반 결정론 회전 — 같은 날이면 어느 화면에서든 같은 질문.
  function genericRecallQuestion(now) {
    const d = now || new Date();
    const dayIndex = d.getFullYear() * 1000 + d.getMonth() * 31 + d.getDate();
    return t("restricted.q" + ((dayIndex % GENERIC_QUESTION_COUNT) + 1));
  }

  // 제한 화면 사진 영역: 세션 이미지가 있을 때만 원본 사진을 보인다. 스타일화 버튼은
  // 아예 존재하지 않는다 (스타일화도 합성 호출이다). 샘플은 기존 no-photo 플레이스홀더.
  function renderRestrictedPhotoArea(area) {
    area.textContent = "";
    if (record.mode === "sample") {
      area.appendChild(makePhotoPlaceholder(t("photo.sampleNone")));
      return;
    }
    if (photoUrl) {
      const img = document.createElement("img");
      img.className = "photo-thumb";
      img.alt = t("photo.alt");
      img.src = photoUrl; // 세션 객체 URL — 절대 저장되지 않는다
      area.appendChild(img);
    }
  }

  function enterPreviewRestricted() {
    renderPreviewRestricted();
    showScreen("screen-preview-restricted");
  }

  function renderPreviewRestricted() {
    $("preview-restricted-mode").textContent = T.outputMode(record);
    renderRestrictedPhotoArea($("preview-restricted-photo-area"));
    $("preview-restricted-question").textContent = genericRecallQuestion();
  }

  function enterBedtimeRestricted() {
    renderBedtimeRestricted();
    showScreen("screen-bedtime-restricted");
  }

  function renderBedtimeRestricted() {
    $("bedtime-restricted-mode").textContent = T.outputMode(record);
    renderRestrictedPhotoArea($("bedtime-restricted-image-area"));
    $("bedtime-restricted-question").textContent = genericRecallQuestion();
    renderTestimonyList($("testimony-list-restricted"));
  }

  // ---------------------------------------------------------------
  // 프리뷰 화면 (S4) — 브리핑 합성 + 질문 카드
  // 합성 입력은 TawCore.synthesisFacts(record)로만 만든다 (candidates 직접 읽기 금지).
  // ---------------------------------------------------------------

  // 질문 카드 진입 가드 (DS-1 P1-2): 전제는 현재 확정 집합의 부분집합이어야 하고
  // unknownId는 현재 unknowns에 있어야 한다. 하나라도 어긋나면 카드를 버린다.
  function questionCardUsable(card, confirmedIds) {
    if (!card || typeof card !== "object") return false;
    if (typeof card.unknownId !== "string" || card.unknownId === "") return false;
    if (!record.unknowns.some(function (u) { return u.id === card.unknownId; })) return false;
    if (!Array.isArray(card.premiseFactIds)) return false;
    return card.premiseFactIds.every(function (id) {
      return typeof id === "string" && confirmedIds.has(id);
    });
  }

  function dropUnusableQuestionCard(confirmedIds) {
    if (record.questionCard && !questionCardUsable(record.questionCard, confirmedIds)) {
      record = Object.assign({}, record, { questionCard: null });
      persist();
    }
  }

  function enterPreview() {
    const confirmed = T.synthesisFacts(record);
    const confirmedIds = new Set(confirmed.map(function (f) { return f.id; }));
    dropUnusableQuestionCard(confirmedIds); // 제한 모드로 진입해도 저장 카드의 유효성을 검사한다.
    // 진입 분기 (S8): CONFIRMED_BRIEF만 기존 프리뷰로 — 그 외(미완료·전부 거절)는
    // 제한 화면으로. 제한 모드에서는 합성 호출이 절대 나가지 않는다.
    if (T.outputMode(record) !== "CONFIRMED_BRIEF") {
      enterPreviewRestricted();
      return;
    }
    previewError = "";
    const card = record.questionCard;
    premiseSelection = card ? card.premiseFactIds.slice() : [];
    selectedUnknownId = card
      ? card.unknownId
      : (record.unknowns.length > 0 ? record.unknowns[record.unknowns.length - 1].id : "");
    renderPreviewScreen();
    showScreen("screen-preview");
    if (confirmed.length === 0) return; // 전부 거절 — 안내만 보여준다

    // 진입 가드: 저장된 briefing의 factIds가 현재 확정 집합의 부분집합이 아니면
    // 버리고 재합성 상태로 진입한다 (패킷 B1).
    const briefingUsable = record.briefing && record.briefing.length > 0 &&
      record.briefing.every(function (line) {
        return Array.isArray(line.factIds) && line.factIds.length > 0 &&
          line.factIds.every(function (id) { return confirmedIds.has(id); });
      });
    if (!briefingUsable) {
      record = Object.assign({}, record, { briefing: null });
      briefingFallbackNotice = false;
      persist();
      synthesizeBriefingWithRetry();
    } else {
      previewRawSnippet = ""; // 재진입 성공 — 낡은 실패 원문을 비운다 (P2-3)
    }
  }

  function renderPreviewScreen() {
    $("preview-mode").textContent = record.mode === "sample" ? t("mode.sample") : t("mode.live");
    const confirmed = T.synthesisFacts(record);
    const noFacts = confirmed.length === 0;
    $("preview-no-facts").hidden = !noFacts;
    $("preview-main").hidden = noFacts;
    if (noFacts) return;

    $("preview-synth-status").textContent = synthesizing ? t("preview.composing") : "";
    $("preview-error").hidden = previewError === "";
    $("preview-error").textContent = previewError;
    $("preview-fallback-notice").hidden = !(briefingFallbackNotice && record.briefing);
    $("resynthesize-btn").disabled = synthesizing || questionDrafting;
    $("preview-debug").hidden = previewRawSnippet === "";
    $("preview-debug-body").textContent = previewRawSnippet; // 모델 원문 — 텍스트로만

    const linesWrap = $("briefing-lines");
    linesWrap.textContent = "";
    if (record.briefing && record.briefing.length > 0) {
      const factTextById = {};
      for (const f of confirmed) factTextById[f.id] = f.text;
      for (const line of record.briefing) {
        linesWrap.appendChild(makeBriefingLine(line, factTextById));
      }
      $("briefing-empty-hint").hidden = true;
    } else {
      $("briefing-empty-hint").hidden = synthesizing; // 합성 중이면 상태 줄이 대신 보인다
    }

    renderQuestionCardArea(confirmed);
  }

  // 브리핑 줄: 문장(textContent) + 인용 factId 칩 — 칩을 누르면 원문 사실을 보여준다.
  function makeBriefingLine(line, factTextById) {
    const wrap = document.createElement("div");
    wrap.className = "briefing-line";
    const text = document.createElement("p");
    text.className = "candidate-text";
    text.textContent = line.text; // 모델 텍스트 — textContent로만
    wrap.appendChild(text);

    const chips = document.createElement("div");
    chips.className = "chips";
    const detail = document.createElement("div");
    detail.className = "fact-detail";
    detail.hidden = true;
    for (const factId of line.factIds) {
      const chip = makeChip(factId, "chip-fact");
      chip.addEventListener("click", function () {
        detail.hidden = !detail.hidden;
        // 하니스 프로토콜 형식("원문 (ID):") — 페이지 문장과 동일하게 한국어 고정 (빠진 사실 안내문만 t()).
        detail.textContent = "원문 (" + factId + "): " + (factTextById[factId] || t("provenance.missing"));
      });
      chips.appendChild(chip);
    }
    wrap.appendChild(chips);
    wrap.appendChild(detail);
    return wrap;
  }

  // 교정 피드백 (S7-fix A1): 위반 종류 + 문장 위치만 담는다 — 거절된 문장 전문·사실 전문·
  // 후보 유래 문자열(ID 등)은 어떤 재시도 페이로드에도 실리지 않는다. 종류는 reason의
  // 상세부(": 뒤")를 떼어낸 것 — ID·원문 인용이 상세부에 숨어 있기 때문이다.
  function correctionNoteFromViolations(violations) {
    return (Array.isArray(violations) ? violations : []).map(function (v) {
      const kind = v && typeof v.reason === "string" && v.reason !== ""
        ? v.reason.split(":")[0]
        : "위반";
      const position = v && typeof v.index === "number" ? v.index + 1 : "?";
      return "- 문장 " + position + ": " + kind;
    }).join("\n");
  }

  // 브리핑 합성 — 무효화 epoch를 기억하고 응답 적용 전에 비교한다.
  // validateComposition 위반 시 1회만 위반 내용을 프롬프트에 넣어 재합성, 재실패 시 폴백.
  async function synthesizeBriefingWithRetry() {
    if (synthesizing) return;
    const confirmed = T.synthesisFacts(record);
    if (confirmed.length === 0) return;
    synthesizing = true;
    previewError = "";
    renderPreviewScreen();
    const epoch = invalidationEpoch; // 무효화 사건에만 폐기된다 (독립 작업은 서로를 버리지 않는다)
    try {
      let correctionNote = null;
      let lines = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (invalidationEpoch !== epoch) return; // 세션이 무효화됐다 — 조용히 중단
        let parseFailed = false;
        try {
          lines = await requestBriefingLines(confirmed, correctionNote);
        } catch (err) {
          if (invalidationEpoch !== epoch) return;
          if (err && err.rawSnippet) {
            // 모델이 깨진 JSON을 줬다 — 같은 루프에서 1회 교정을 시도한다.
            parseFailed = true;
            previewRawSnippet = err.rawSnippet;
            // A1: 스니펫은 이전 답안 원문이라 재시도 페이로드에 실리지 않는다 (디버그 표시 전용).
            correctionNote = "이전 답안은 깨진 JSON이었다. 설명 없이 JSON만 출력하라.";
            lines = null;
          } else {
            throw err; // 네트워크/HTTP 오류 — 배너로 (재시도는 수동)
          }
        }
        if (!parseFailed) {
          const check = T.validateComposition(lines, confirmed.map(function (f) { return f.id; }));
          if (check.ok) break;
          correctionNote = correctionNoteFromViolations(check.violations);
          lines = null;
        }
      }
      if (invalidationEpoch !== epoch) return; // 늦은 응답 — 조용히 버린다
      if (lines) {
        previewRawSnippet = ""; // 재합성 성공 — 낡은 실패 원문을 비운다 (P2-3)
        applyBriefing(lines, false);
      } else {
        // 1회 재합성 후에도 실패 — 폴백: 확정 사실 원문을 그대로 브리핑 줄로
        applyBriefing(confirmed.map(function (f) {
          return { text: f.text, factIds: [f.id] };
        }), true);
      }
    } catch (err) {
      if (invalidationEpoch !== epoch) return;
      previewError = t("preview.briefingFailed", { message: err && err.message ? err.message : t("error.unknown") });
      previewRawSnippet = err && err.rawSnippet ? err.rawSnippet : "";
    } finally {
      if (invalidationEpoch === epoch) {
        synthesizing = false;
        renderPreviewScreen();
      }
    }
  }

  async function requestBriefingLines(confirmed, correctionNote) {
    let userContent = JSON.stringify(confirmed.map(function (f) {
      return { id: f.id, text: f.text };
    }));
    if (correctionNote) {
      userContent += "\n\n이전 답안은 아래 이유로 기각됐다 — 이번에는 규칙을 지켜라:\n" + correctionNote;
    }
    const response = await fetch(WORKER_URL + "/api/spark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        reasoning_effort: "low",
        messages: [
          { role: "system", content: BRIEFING_SYSTEM_PROMPT },
          { role: "user", content: userContent }
        ]
      })
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(t("error.workerHttp", { status: response.status }));
    }
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch (err) {
      throw new Error(t("error.notJson"));
    }
    const content = payload && payload.choices && payload.choices[0] &&
      payload.choices[0].message ? payload.choices[0].message.content : undefined;
    if (typeof content !== "string") {
      throw new Error(t("error.noContent"));
    }
    const raw = parseModelJson(content, t("parse.briefing"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.lines)) {
      const err = new Error(t("error.badShapeLines"));
      err.rawSnippet = content.slice(0, 400);
      throw err;
    }
    return raw.lines.map(function (line) {
      return {
        text: line && typeof line.text === "string" ? line.text : "",
        factIds: line && Array.isArray(line.factIds)
          ? line.factIds.filter(function (id) { return typeof id === "string"; })
          : []
      };
    });
  }

  // core에 합성 적용 함수가 없어(패킷 범위 밖) 화면 층에서 불변 갱신으로 적용한다.
  // 적용 전 토큰 가드는 synthesizeBriefingWithRetry가 책임진다.
  function applyBriefing(lines, isFallback) {
    record = Object.assign({}, record, { briefing: lines });
    briefingFallbackNotice = isFallback;
    persist();
  }

  // ---------------------------------------------------------------
  // 질문 카드 (S4 B3)
  // ---------------------------------------------------------------

  function renderQuestionCardArea(confirmed) {
    const select = $("question-unknown");
    select.textContent = "";
    if (record.unknowns.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = t("question.noUnknown");
      select.appendChild(opt);
      select.disabled = true;
    } else {
      select.disabled = false;
      for (const u of record.unknowns) {
        const opt = document.createElement("option");
        opt.value = u.id;
        opt.textContent = u.text; // 모델 텍스트 — textContent로만
        select.appendChild(opt);
      }
      const fallbackId = record.unknowns[record.unknowns.length - 1].id; // 기본값: 마지막 unknown
      select.value = selectedUnknownId && record.unknowns.some(function (u) { return u.id === selectedUnknownId; })
        ? selectedUnknownId
        : fallbackId;
      selectedUnknownId = select.value;
    }

    const premiseWrap = $("premise-chips");
    premiseWrap.textContent = "";
    for (const f of confirmed) {
      const chip = makeChip(f.id + " · " + f.text, premiseSelection.indexOf(f.id) !== -1 ? "chip-premise-on" : "");
      chip.addEventListener("click", function () { togglePremise(f.id); });
      premiseWrap.appendChild(chip);
    }

    const card = record.questionCard;
    $("question-text").value = card ? card.text : "";
    $("question-text").readOnly = !card; // 초안이 생겨야 수정할 수 있다
    $("draft-btn").disabled = questionDrafting || record.unknowns.length === 0;
    $("draft-btn").textContent = questionDrafting ? t("question.drafting") : t("preview.draft");
    $("question-card-meta").textContent = card
      ? t("question.meta", { id: card.unknownId, ids: card.premiseFactIds.length > 0 ? card.premiseFactIds.join(", ") : t("question.none") })
      : t("question.noDraft");
  }

  function togglePremise(factId) {
    const index = premiseSelection.indexOf(factId);
    if (index === -1) premiseSelection.push(factId);
    else premiseSelection.splice(index, 1);
    if (record.questionCard) {
      // 이미 만든 카드의 전제도 함께 갱신해 기록을 일치시킨다
      record = Object.assign({}, record, {
        questionCard: Object.assign({}, record.questionCard, { premiseFactIds: premiseSelection.slice() })
      });
      persist();
    }
    renderPreviewScreen();
  }

  function onUnknownChange() {
    selectedUnknownId = $("question-unknown").value;
    if (record.questionCard) {
      record = Object.assign({}, record, {
        questionCard: Object.assign({}, record.questionCard, { unknownId: selectedUnknownId })
      });
      persist();
    }
  }

  function onQuestionTextEdit() {
    if (!record.questionCard) return;
    record = Object.assign({}, record, {
      questionCard: Object.assign({}, record.questionCard, { text: $("question-text").value })
    });
    persist();
  }

  async function runQuestionDraft() {
    if (questionDrafting) return;
    const unknown = record.unknowns.find(function (u) { return u.id === selectedUnknownId; });
    if (!unknown) return;
    const premises = T.synthesisFacts(record).filter(function (f) {
      return premiseSelection.indexOf(f.id) !== -1;
    });
    questionDrafting = true;
    previewError = "";
    renderPreviewScreen();
    const epoch = invalidationEpoch; // 무효화 사건에만 폐기 — 브리핑과 독립
    try {
      const response = await fetch(WORKER_URL + "/api/spark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "muse-spark-1.3",
          reasoning_effort: "low",
          messages: [
            { role: "system", content: QUESTION_SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify({
              unknown: { id: unknown.id, text: unknown.text },
              premiseFacts: premises.map(function (f) { return { id: f.id, text: f.text }; })
            }) }
          ]
        })
      });
      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(t("error.workerHttp", { status: response.status }));
      }
      let payload;
      try {
        payload = JSON.parse(rawText);
      } catch (err) {
        throw new Error(t("error.notJson"));
      }
      const content = payload && payload.choices && payload.choices[0] &&
        payload.choices[0].message ? payload.choices[0].message.content : undefined;
      if (typeof content !== "string") {
        throw new Error(t("error.noContent"));
      }
      const raw = JSON.parse(stripCodeFence(content));
      if (!raw || typeof raw !== "object" || typeof raw.text !== "string" || raw.text.trim() === "") {
        throw new Error(t("error.badShapeText"));
      }
      if (invalidationEpoch !== epoch) return; // 늦은 응답 — 조용히 버린다
      record = Object.assign({}, record, {
        // 저장은 요청에 실제로 실린 필터링된 전제만 — premiseSelection 원본 복사 금지 (DS-1 P1-2)
        questionCard: { text: raw.text, unknownId: unknown.id, premiseFactIds: premises.map(function (f) { return f.id; }) }
      });
      persist();
    } catch (err) {
      if (invalidationEpoch !== epoch) return;
      previewError = t("question.draftFailed", { message: err && err.message ? err.message : t("error.unknown") });
    } finally {
      if (invalidationEpoch === epoch) {
        questionDrafting = false;
        renderPreviewScreen();
      }
    }
  }

  // ---------------------------------------------------------------
  // 취침 페이지 (S5) — 문장 합성(LEAK 검사 포함) + 스타일화 + 증언
  // 증언은 합성 입력에 절대 들어가지 않는다 — 합성은 synthesisFacts만 쓴다.
  // ---------------------------------------------------------------

  function enterBedtime() {
    const confirmed = T.synthesisFacts(record);
    const confirmedIds = new Set(confirmed.map(function (f) { return f.id; }));
    dropUnusableQuestionCard(confirmedIds); // 제한 모드도 같은 카드 진입 가드를 쓴다 (DS-1 P1-2)
    // 진입 분기 (S8): 제한 모드의 밤에도 대화는 일어난다 — 사진 + 일반 질문 + 증언만
    // (페이지 문장 없음). 증언 저장은 기존 경로(record.testimony) 그대로다.
    if (T.outputMode(record) !== "CONFIRMED_BRIEF") {
      enterBedtimeRestricted();
      return;
    }
    pageError = "";
    // 진입 가드: pageSentences의 factIds가 현재 확정 집합의 부분집합이 아니거나
    // LEAK 검사를 통과하지 못하면 버리고 재합성 상태로 진입한다 (프리뷰 가드와 동일).
    const factsById = {};
    for (const f of confirmed) factsById[f.id] = f;
    const composition = T.validateComposition(record.pageSentences, confirmed.map(function (f) { return f.id; }));
    const leaks = T.checkLeaks(record.pageSentences, factsById);
    const usable = Array.isArray(record.pageSentences) && record.pageSentences.length > 0 &&
      composition.ok && leaks.ok;
    if (!usable) {
      record = Object.assign({}, record, { pageSentences: [] });
      pageFallbackNotice = false;
      persist();
    }
    // 저장된 문장도 검증을 마친 뒤에만 화면에 쓴다.
    renderBedtimeScreen();
    showScreen("screen-bedtime");
    if (!usable) {
      synthesizePageWithRetry();
    }
  }

  function renderBedtimeScreen() {
    $("bedtime-mode").textContent = record.mode === "sample" ? t("mode.sample") : t("mode.live");
    const confirmed = T.synthesisFacts(record);
    const noFacts = confirmed.length === 0;
    $("bedtime-no-facts").hidden = !noFacts;
    $("bedtime-main").hidden = noFacts;
    if (noFacts) return;

    renderBedtimeImageArea();
    $("bedtime-fallback-notice").hidden = !(pageFallbackNotice && record.pageSentences.length > 0);
    $("bedtime-synth-status").textContent = pageSynthesizing ? t("page.composing") : "";
    $("bedtime-error").hidden = pageError === "";
    $("bedtime-error").textContent = pageError;
    $("bedtime-debug").hidden = pageRawSnippet === "";
    $("bedtime-debug-body").textContent = pageRawSnippet; // 모델 원문 — 텍스트로만
    $("recompose-btn").disabled = pageSynthesizing || stylizing;

    const factsById = {};
    for (const f of confirmed) factsById[f.id] = f.text;
    const wrap = $("page-sentences");
    wrap.textContent = "";
    if (record.pageSentences.length > 0) {
      for (const sentence of record.pageSentences) {
        wrap.appendChild(makePageSentence(sentence, factsById));
      }
      $("page-empty-hint").hidden = true;
    } else {
      $("page-empty-hint").hidden = pageSynthesizing;
    }

    renderBedtimeQuestion();
    renderTestimonyList();
  }

  // 스타일화 이미지 영역 — 라이브 전용, 결과는 세션 표시 전용이다.
  function renderBedtimeImageArea() {
    const area = $("bedtime-image-area");
    area.textContent = "";
    if (record.mode === "sample") {
      area.appendChild(makePhotoPlaceholder(t("photo.sampleNone")));
      return;
    }
    if (styleImageUrl) {
      const img = document.createElement("img");
      img.className = "photo-thumb";
      img.alt = t("picture.alt");
      img.src = styleImageUrl;
      area.appendChild(img);
    } else if (photoDataUrl) {
      const btn = document.createElement("button");
      btn.id = "stylize-btn";
      btn.textContent = stylizing ? t("bedtime.stylizing") : t("bedtime.stylize");
      btn.disabled = stylizing;
      btn.addEventListener("click", runStylization);
      area.appendChild(btn);
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = t("bedtime.stylizeHint");
      area.appendChild(hint);
    } else {
      const notice = document.createElement("p");
      notice.className = "hint";
      notice.textContent = t("bedtime.stylizeNoPhoto");
      area.appendChild(notice);
    }
    if (styleError !== "") {
      const err = document.createElement("div");
      err.className = "error";
      err.textContent = styleError;
      area.appendChild(err);
      if (styleRawSnippet !== "") {
        const pre = document.createElement("pre");
        pre.className = "debug";
        pre.textContent = styleRawSnippet;
        area.appendChild(pre);
      }
    }
  }

  // 페이지 문장 카드 — 각 문장 아래에 인용한 사실의 원문을 기본으로 펼쳐 보여준다
  // (칩만 두지 않는다 — 출처가 눈에 보여야 한다).
  function makePageSentence(sentence, factTextById) {
    const card = document.createElement("div");
    card.className = "briefing-line";
    const text = document.createElement("p");
    text.className = "candidate-text";
    text.textContent = sentence.text; // 모델 텍스트 — textContent로만
    card.appendChild(text);
    for (const factId of sentence.factIds) {
      const prov = document.createElement("div");
      prov.className = "provenance";
      // 하니스 v2가 이 렌더 형식("원문 (ID):")을 정규식으로 검증한다 — 교정 피드백 형식과
      // 같은 내부 프로토콜이라 UI 언어를 따르지 않는다 (빠진 사실 안내문만 t() 경유).
      prov.textContent = "원문 (" + factId + "): " + (factTextById[factId] || t("provenance.missing"));
      card.appendChild(prov);
    }
    return card;
  }

  // 페이지 문장 합성 — S4 루프 재사용 + LEAK 검사 합침.
  // 완화 파싱 → (위반·누출) 1회 교정 재합성 → 재실패 시 폴백(확정 사실 원문).
  async function synthesizePageWithRetry() {
    if (pageSynthesizing) return;
    const confirmed = T.synthesisFacts(record);
    if (confirmed.length === 0) return;
    pageSynthesizing = true;
    pageError = "";
    pageRawSnippet = "";
    renderBedtimeScreen();
    const epoch = invalidationEpoch; // 무효화 사건에만 폐기 — 스타일화와 독립
    try {
      const factsById = {};
      for (const f of confirmed) factsById[f.id] = f;
      let correctionNote = null;
      let sentences = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (invalidationEpoch !== epoch) return; // 세션이 무효화됐다 — 조용히 중단
        let parseFailed = false;
        try {
          sentences = await requestPageSentences(confirmed, correctionNote);
        } catch (err) {
          if (invalidationEpoch !== epoch) return;
          if (err && err.rawSnippet) {
            parseFailed = true;
            pageRawSnippet = err.rawSnippet;
            // A1: 스니펫은 이전 답안 원문이라 재시도 페이로드에 실리지 않는다 (디버그 표시 전용).
            correctionNote = "이전 답안은 깨진 JSON이었다. 설명 없이 JSON만 출력하라.";
            sentences = null;
          } else {
            throw err; // 네트워크/HTTP 오류 — 배너로
          }
        }
        if (!parseFailed) {
          const composition = T.validateComposition(sentences, confirmed.map(function (f) { return f.id; }));
          const leaks = T.checkLeaks(sentences, factsById);
          const all = composition.violations.concat(leaks.violations);
          if (all.length === 0) break;
          correctionNote = correctionNoteFromViolations(all);
          sentences = null;
        }
      }
      if (invalidationEpoch !== epoch) return; // 늦은 응답 — 조용히 버린다
      if (sentences) {
        applyPageSentences(sentences, false);
      } else {
        // 1회 재합성 후에도 실패 — 폴백: 확정 사실 원문이 곧 페이지 문장
        applyPageSentences(confirmed.map(function (f) {
          return { text: f.text, factIds: [f.id] };
        }), true);
      }
    } catch (err) {
      if (invalidationEpoch !== epoch) return;
      pageError = t("page.composeFailed", { message: err && err.message ? err.message : t("error.unknown") });
      pageRawSnippet = err && err.rawSnippet ? err.rawSnippet : "";
    } finally {
      if (invalidationEpoch === epoch) {
        pageSynthesizing = false;
        renderBedtimeScreen();
      }
    }
  }

  async function requestPageSentences(confirmed, correctionNote) {
    let userContent = JSON.stringify(confirmed.map(function (f) {
      return { id: f.id, text: f.text };
    }));
    if (correctionNote) {
      userContent += "\n\n이전 답안은 아래 이유로 기각됐다 — 이번에는 규칙을 지켜라:\n" + correctionNote;
    }
    const response = await fetch(WORKER_URL + "/api/spark", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "muse-spark-1.3",
        reasoning_effort: "low",
        messages: [
          { role: "system", content: PAGE_SYSTEM_PROMPT },
          { role: "user", content: userContent }
        ]
      })
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(t("error.workerHttp", { status: response.status }));
    }
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch (err) {
      throw new Error(t("error.notJson"));
    }
    const content = payload && payload.choices && payload.choices[0] &&
      payload.choices[0].message ? payload.choices[0].message.content : undefined;
    if (typeof content !== "string") {
      throw new Error(t("error.noContent"));
    }
    const raw = parseModelJson(content, t("parse.page"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.sentences)) {
      const err = new Error(t("error.badShapeSentences"));
      err.rawSnippet = content.slice(0, 400);
      throw err;
    }
    return raw.sentences.map(function (sentence) {
      return {
        text: sentence && typeof sentence.text === "string" ? sentence.text : "",
        factIds: sentence && Array.isArray(sentence.factIds)
          ? sentence.factIds.filter(function (id) { return typeof id === "string"; })
          : []
      };
    });
  }

  function applyPageSentences(sentences, isFallback) {
    record = Object.assign({}, record, { pageSentences: sentences });
    pageFallbackNotice = isFallback;
    persist();
  }

  // 질문 카드는 프리뷰에서 만든 것을 그대로 표시한다 (수정은 프리뷰의 몫).
  function renderBedtimeQuestion() {
    const wrap = $("bedtime-question");
    wrap.textContent = "";
    const card = record.questionCard;
    if (!card || card.text.trim() === "") {
      const notice = document.createElement("p");
      notice.className = "hint";
      notice.textContent = t("question.makeInPreview");
      wrap.appendChild(notice);
      return;
    }
    const item = document.createElement("div");
    item.className = "briefing-line";
    const text = document.createElement("p");
    text.className = "candidate-text";
    text.textContent = card.text; // 모델+부모 수정 텍스트 — textContent로만
    item.appendChild(text);
    const meta = document.createElement("div");
    meta.className = "chips";
    meta.appendChild(makeChip(t("question.unknownChip", { id: card.unknownId }), ""));
    item.appendChild(meta);
    wrap.appendChild(item);
  }

  // 증언 — {text, at}로 testimony에 추가 (S4a 직렬화 사용).
  // 증언은 합성 입력에 절대 들어가지 않는다 (이 파일 어디에도 testimony를 payload에 넣지 않는다).
  function appendTestimony(text) {
    record = Object.assign({}, record, {
      testimony: record.testimony.concat([{ text: text, at: Date.now() }])
    });
    persist();
  }

  function saveTestimony() {
    const input = $("testimony-input");
    const text = input.value.trim();
    if (text === "") return;
    appendTestimony(text);
    input.value = "";
    renderBedtimeScreen();
  }

  // 제한 취침 화면 (S8) — 저장 경로는 기존과 동일하다 (같은 record.testimony).
  function saveTestimonyRestricted() {
    const input = $("testimony-input-restricted");
    const text = input.value.trim();
    if (text === "") return;
    appendTestimony(text);
    input.value = "";
    renderTestimonyList($("testimony-list-restricted"));
  }

  function renderTestimonyList(listEl) {
    const list = listEl || $("testimony-list");
    list.textContent = "";
    for (const entry of record.testimony) {
      const item = document.createElement("div");
      item.className = "testimony-item";
      const time = document.createElement("span");
      time.className = "testimony-time";
      time.textContent = new Date(entry.at).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
      const text = document.createElement("span");
      text.textContent = entry.text; // 부모가 적은 증언 — textContent로만
      item.appendChild(time);
      item.appendChild(text);
      list.appendChild(item);
    }
  }

  // 스타일화 (라이브 전용) — 동결 프롬프트 사용. 결과는 세션 표시 전용이고
  // 레코드에 넣지 않고 저장하지 않는다. 응답 형식은 문서화돼 있지 않아 흔한 형태를 찾는다.
  async function runStylization() {
    if (stylizing) return;
    if (record.mode !== "live" || !photoDataUrl) return;
    stylizing = true;
    styleError = "";
    styleRawSnippet = "";
    renderBedtimeScreen();
    const epoch = invalidationEpoch; // 무효화 사건(사진 교체 포함)에만 폐기 — 페이지 합성과 독립
    try {
      // /api/image JSON 계약 (Worker 에러 메시지로 확인): prompt 필수 + images 배열
      // (항목에 image_url 또는 file_id). messages 필드는 이미지 편집에서 지원하지 않는다.
      const response = await fetch(WORKER_URL + "/api/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: IMAGE_MODEL,
          prompt: IMAGE_PROMPT,
          images: [{ image_url: photoDataUrl }]
        })
      });
      const rawText = await response.text();
      if (!response.ok) {
        throw new Error(t("error.workerHttp", { status: response.status }));
      }
      let payload;
      try {
        payload = JSON.parse(rawText);
      } catch (err) {
        throw new Error(t("error.notJson"));
      }
      let imageData = payload && payload.data && payload.data[0] &&
        (payload.data[0].b64_json || payload.data[0].url);
      if (!imageData) imageData = payload && (payload.image || payload.url || payload.b64_json);
      if (typeof imageData !== "string" || imageData === "") {
        const err = new Error(t("error.noImage"));
        err.rawSnippet = rawText.slice(0, 400);
        throw err;
      }
      if (invalidationEpoch !== epoch) return; // 늦은 응답 — 조용히 버린다
      if (styleImageUrl) {
        URL.revokeObjectURL(styleImageUrl);
        styleImageUrl = null;
      }
      styleImageUrl = imageData.indexOf("data:") === 0 || imageData.indexOf("blob:") === 0 || imageData.indexOf("http") === 0
        ? imageData
        : "data:image/png;base64," + imageData;
    } catch (err) {
      if (invalidationEpoch !== epoch) return;
      styleError = t("style.failed", { message: err && err.message ? err.message : t("error.unknown") });
      styleRawSnippet = err && err.rawSnippet ? err.rawSnippet : "";
    } finally {
      if (invalidationEpoch === epoch) {
        stylizing = false;
        renderBedtimeScreen();
      }
    }
  }

  // ---------------------------------------------------------------
  // 교체 전이: 새 하루 / 샘플 로드 (병합이 아니라 완전 교체다)
  // ---------------------------------------------------------------

  function startNewDay() {
    invalidatePendingWork(); // 새 하루 — 진행 중 작업 전부 폐기
    record = T.createDayRecord(); // 이전 레코드와 병합 없음
    burnedFactIds = new Set(); // 새 하루 교체 전이 — 구 세대 소진 집합도 비운다 (S7-fix A3)
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl);
      photoUrl = null;
    }
    photoFile = null;
    voiceFile = null;
    lastDebugText = "";
    previewError = "";
    briefingFallbackNotice = false;
    premiseSelection = [];
    selectedUnknownId = "";
    if (photoDataUrl) photoDataUrl = null; // 세션 data URL도 폐기
    if (styleImageUrl) {
      URL.revokeObjectURL(styleImageUrl);
      styleImageUrl = null;
    }
    pageSynthesizing = false;
    pageFallbackNotice = false;
    pageError = "";
    pageRawSnippet = "";
    stylizing = false;
    styleError = "";
    styleRawSnippet = "";
    persist();
    hideCaptureError();
    $("capture-notice").hidden = true;
    $("voice-status").textContent = "";
    $("voice-input").value = "";
    renderCaptureScreen();
    showScreen("screen-capture");
  }

  // ---------------------------------------------------------------
  // 새 하루 확인 단계: [시작]을 눌렀을 때만 startNewDay 가 실행된다
  // ---------------------------------------------------------------

  function openNewDayConfirm() {
    $("new-day-confirm-overlay").hidden = false;
  }

  function closeNewDayConfirm() {
    $("new-day-confirm-overlay").hidden = true;
  }

  function loadSampleDay() {
    invalidatePendingWork(); // 샘플 전환 — 진행 중 작업 전부 폐기
    const base = Object.assign(T.createDayRecord(), {
      mode: "sample",
      memoText: SAMPLE_DAY.memo.text
    });
    const token = T.beginExtraction(base);
    record = T.applyExtraction(base, token, SAMPLE_DAY); // 샘플도 라이브와 같은 정규화 경로
    burnedFactIds = new Set(); // 샘플 교체 전이 — 소진 집합 초기화 (S7-fix A3)
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl);
      photoUrl = null;
    }
    photoFile = null;
    voiceFile = null;
    lastDebugText = "";
    previewError = "";
    briefingFallbackNotice = false;
    premiseSelection = [];
    selectedUnknownId = "";
    if (photoDataUrl) photoDataUrl = null;
    if (styleImageUrl) {
      URL.revokeObjectURL(styleImageUrl);
      styleImageUrl = null;
    }
    pageSynthesizing = false;
    pageFallbackNotice = false;
    pageError = "";
    pageRawSnippet = "";
    stylizing = false;
    styleError = "";
    styleRawSnippet = "";
    persist();
    hideCaptureError();
    renderGate1Screen();
    showScreen("screen-gate1");
  }

  // ---------------------------------------------------------------
  // 정적 버튼 연결 (1회)
  // ---------------------------------------------------------------

  function wireStaticHandlers() {
    $("photo-input").addEventListener("change", onPhotoChange);
    $("memo-input").addEventListener("input", onMemoInput);
    $("extract-btn").addEventListener("click", runExtraction);
    $("voice-input").addEventListener("change", onVoiceChange);
    $("transcribe-btn").addEventListener("click", runTranscription);
    $("load-sample-btn").addEventListener("click", loadSampleDay);
    $("back-to-gate1-btn").addEventListener("click", function () {
      renderGate1Screen();
      showScreen("screen-gate1");
    });
    $("new-day-capture-btn").addEventListener("click", openNewDayConfirm);

    $("batch-confirm-btn").addEventListener("click", batchConfirmC);
    $("goto-confirmed-btn").addEventListener("click", function () {
      renderConfirmedScreen();
      showScreen("screen-confirmed");
    });
    $("edit-memo-btn").addEventListener("click", function () {
      renderCaptureScreen();
      showScreen("screen-capture");
    });
    $("new-day-gate1-btn").addEventListener("click", openNewDayConfirm);

    $("back-to-gate1-from-confirmed-btn").addEventListener("click", function () {
      renderGate1Screen();
      showScreen("screen-gate1");
    });
    $("open-preview-btn").addEventListener("click", enterPreview);
    $("new-day-confirmed-btn").addEventListener("click", openNewDayConfirm);
    $("new-day-confirm-start-btn").addEventListener("click", function () {
      closeNewDayConfirm();
      startNewDay(); // 기존 초기화 동작 그대로 — 확인에서만 닿는다
    });
    $("new-day-confirm-cancel-btn").addEventListener("click", closeNewDayConfirm);

    $("resynthesize-btn").addEventListener("click", function () {
      previewError = "";
      synthesizeBriefingWithRetry();
    });
    $("back-to-confirmed-btn").addEventListener("click", function () {
      renderConfirmedScreen();
      showScreen("screen-confirmed");
    });
    $("draft-btn").addEventListener("click", runQuestionDraft);
    $("question-unknown").addEventListener("change", onUnknownChange);
    $("question-text").addEventListener("input", onQuestionTextEdit);

    $("open-bedtime-btn").addEventListener("click", enterBedtime);
    $("back-to-preview-btn").addEventListener("click", function () {
      renderPreviewScreen();
      showScreen("screen-preview");
    });
    $("recompose-btn").addEventListener("click", function () {
      pageError = "";
      synthesizePageWithRetry();
    });
    $("save-testimony-btn").addEventListener("click", saveTestimony);
    $("testimony-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") saveTestimony();
    });

    // 제한 모드 (S8) — 제한 프리뷰/취침 화면 컨트롤
    $("open-bedtime-restricted-btn").addEventListener("click", enterBedtimeRestricted);
    $("back-to-confirmed-from-restricted-btn").addEventListener("click", function () {
      renderConfirmedScreen();
      showScreen("screen-confirmed");
    });
    $("back-to-preview-from-restricted-btn").addEventListener("click", function () {
      renderPreviewRestricted();
      showScreen("screen-preview-restricted");
    });
    $("save-testimony-btn-restricted").addEventListener("click", saveTestimonyRestricted);
    $("testimony-input-restricted").addEventListener("keydown", function (e) {
      if (e.key === "Enter") saveTestimonyRestricted();
    });

    // 언어 선택 (S-i18n) — 저장은 taw-lang, taw-day-v1과 별개
    $("lang-select").addEventListener("change", onLanguageChange);
  }

  // ---------------------------------------------------------------
  // 시작: 저장 상태 복원
  // ---------------------------------------------------------------

  function init() {
    wireStaticHandlers();
    initI18n(); // 첫 렌더 전에 언어 확정 — 렌더는 t()를 읽는다
    let saved = null;
    try {
      saved = T.restore(localStorage.getItem(T.STORAGE_KEY));
    } catch (err) {
      saved = null;
    }
    record = saved !== null ? saved : T.createDayRecord();
    if (record.candidates.length > 0) {
      renderGate1Screen();
      showScreen("screen-gate1");
    } else {
      renderCaptureScreen();
      showScreen("screen-capture");
    }
  }

  init();

  // 서비스 워커 등록. sw.js 자체는 별도 관리 (S1c: v2 network-first).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
})();
