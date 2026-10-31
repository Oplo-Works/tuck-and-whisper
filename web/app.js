// Tuck & Whisper — 화면 층: Capture / Gate 1 / 확정 목록 + 라이브 Spark 추출 (S2)
// 상태 전이는 전부 core.js(TawCore)의 함수로만 한다. 이 파일은 렌더링·이벤트·Worker 호출을 담당한다.
// 모델이 만든 텍스트는 전부 textContent로 넣는다 (innerHTML 금지). 화면당 렌더 함수 1개.

(function () {
  "use strict";

  const T = window.TawCore;

  // Worker 기본 URL — 브리프 v2: "코드 상수로 그대로 쓸 것". API 키는 여기 없다 (Worker Secret에만 있다).
  const WORKER_URL = "https://taw-meta-proxy.minkyuthebuilder.workers.dev";

  // 브리프 v2의 동결된 추출 시스템 프롬프트 — 요약·재조립 금지, 한 글자도 바꾸지 마라.
  const SPARK_SYSTEM_PROMPT = `너는 부모가 아이와 보낸 하루의 사진과 메모에서 '사실 후보'를 추출하는 도구다.
규칙:
- 사진에서 직접 관찰 가능한 것과 메모에 진술된 것만 후보로 만든다. 추측·서사·감정 단정은 금지.
- 각 후보에 출처(source: "photo"|"memo")와 등급(grade)을 붙인다. 등급: 직접 관찰/단순 진술은 "C", 행동·감정·원인·의도에 관한 진술은 "B" (부모 개별 확인 대상).
- 사진으로 단정할 수 없는 것(견종, 성별, 소유 관계, 아이의 기분 등)은 후보로 만들지 말고 unknowns에 질문형으로 넣는다.
- 아이와 동물의 상호작용 — 시선 교환, 올려다봄/내려다봄, 신체 접촉, 몸의 방향 — 도 관찰 후보로 빠짐없이 포함한다.
- 출력은 JSON만: {"candidates":[{"text":"...","source":"photo|memo","grade":"B|C"}],"unknowns":["..."]}`;

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

  function $(id) { return document.getElementById(id); }

  // --- 화면 전환 (단일 헬퍼) ---
  const SCREENS = ["screen-capture", "screen-gate1", "screen-confirmed"];
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
    if (decision === "confirmed") return "확정";
    if (decision === "rejected") return "거절";
    return "미결정";
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
      ? "선택한 사진: " + photoFile.name + " — 사진은 저장되지 않는다 (새로고침하면 사라진다)."
      : "";
    updateExtractButton();
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
    btn.textContent = running ? "추출 중…" : "추출";
    btn.disabled = running;
  }

  // 무효화 규칙: 추출 결과가 있는 상태에서 사진/메모가 바뀌면 전부 비운다.
  // 새 레코드 객체로 교체되믴 진행 중 토큰도 함께 무효가 된다 (늦은 응답은 버려진다).
  function invalidateForChangedInput(message) {
    if (record.candidates.length > 0 || record.unknowns.length > 0) {
      record = Object.assign(T.invalidateExtraction(record), { memoText: $("memo-input").value });
      lastDebugText = "";
      $("capture-notice").textContent = message;
      $("capture-notice").hidden = false;
      $("back-to-gate1-btn").hidden = true;
      persist();
    }
  }

  function onMemoInput() {
    if (record.candidates.length > 0 || record.unknowns.length > 0) {
      invalidateForChangedInput("메모가 바뀌어 이전 추출 결과(후보·결정)를 전부 무효화했다.");
    } else {
      // 후보가 없어도 메모 텍스트는 새 record 객체로 반영된다 — 진행 중 토큰의 레코드와 달라진다.
      record = Object.assign({}, record, { memoText: $("memo-input").value });
      persist();
    }
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
    invalidateForChangedInput("사진이 바뀌어 이전 추출 결과(후보·결정)를 전부 무효화했다.");
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

  // choices[0].message.content → 펜스 제거 → JSON.parse → 구조 검증 (candidates 배열).
  function parseSparkContent(content) {
    const raw = JSON.parse(stripCodeFence(content));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.candidates)) {
      throw new Error("응답 구조가 계약과 다르다 (candidates가 배열이 아님)");
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
    let rawText = "";
    try {
      const dataUrl = await preparePhoto(photoFile);
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
        throw new Error("Worker가 HTTP " + response.status + "로 답했다");
      }
      let payload;
      try {
        payload = JSON.parse(rawText);
      } catch (err) {
        throw new Error("응답이 JSON이 아니다");
      }
      const content = payload && payload.choices && payload.choices[0] &&
        payload.choices[0].message ? payload.choices[0].message.content : undefined;
      if (typeof content !== "string") {
        throw new Error("응답에 choices[0].message.content가 없다");
      }
      const raw = parseSparkContent(content);

      // 늦은 응답 가드: 입력이 바뀌어 record가 교체됐으면(발급 토큰이 무효화됐으면) 조용히 버린다.
      if (record !== token.record) return;

      record = T.applyExtraction(record, token, raw);
      const debug = T.normalizeSpark(raw).debug; // 형식 깨진 항목 — 디버그 영역용
      lastDebugText = debug.length > 0 ? JSON.stringify(debug, null, 2) : "";
      persist();
      if (record.candidates.length === 0) {
        // 형식은 맞지만 확정 가능한 후보가 0개 — 무효한 추출로는 Gate 1에 진입하지 않는다.
        showCaptureError("후보를 하나도 만들지 못했다. 디버그 영역을 확인하고 다시 시도할 수 있다.", rawText);
        return;
      }
      renderGate1Screen();
      showScreen("screen-gate1");
    } catch (err) {
      // 실패 계약: 오류 배너 + 입력(사진·메모) 유지 + 재시도 가능.
      if (record !== token.record) return; // 이미 무효화된 세션 — 늦은 실패는 소음이 된다
      showCaptureError(
        "추출에 실패했다: " + (err && err.message ? err.message : "알 수 없는 오류") +
        " — 입력은 그대로 남아 있다. 다시 시도할 수 있다.",
        rawText
      );
    } finally {
      extracting = false;
      setExtractRunning(false);
      updateExtractButton();
    }
  }

  function showCaptureError(message, rawText) {
    $("capture-error").textContent = message;
    $("capture-error").hidden = false;
    // 원문 응답은 텍스트로만 (HTML 해석 금지)
    $("debug-raw").textContent = "— 오류 —\n" + message +
      "\n\n— Worker 원문 응답 —\n" + (rawText !== "" ? rawText : "(없음 — 네트워크 오류)");
    $("debug-details").hidden = false;
  }

  function hideCaptureError() {
    $("capture-error").hidden = true;
    $("capture-error").textContent = "";
    $("debug-details").hidden = true;
    $("debug-raw").textContent = "";
  }

  // ---------------------------------------------------------------
  // Gate 1 화면
  // ---------------------------------------------------------------

  function renderGate1Screen() {
    // 상단: 모드 / 사진 영역 / 읽기 전용 메모
    $("gate1-mode").textContent = record.mode === "sample" ? "Sample day" : "라이브 하루";
    const photoArea = $("gate1-photo-area");
    photoArea.textContent = "";
    if (record.mode === "sample") {
      // 샘플에 임의 사진을 붙이지 않는다 — 거짓 출처 연관 방지 (브리프)
      photoArea.appendChild(makePhotoPlaceholder("Sample day — no photo"));
    } else if (photoUrl) {
      const img = document.createElement("img");
      img.className = "photo-thumb";
      img.alt = "오늘의 사진 (세션 전용 — 저장되지 않음)";
      img.src = photoUrl; // 세션 객체 URL — 절대 저장되지 않는다
      photoArea.appendChild(img);
    } else {
      photoArea.appendChild(makePhotoPlaceholder("사진은 저장되지 않음"));
    }
    $("gate1-memo").textContent = record.memoText !== "" ? record.memoText : "(메모 없음)";

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
      : (complete ? "모든 후보를 결정했다." : "남은 후보: " + undecidedCount + "개");
    const batchBtn = $("batch-confirm-btn");
    batchBtn.hidden = undecidedC.length === 0;
    batchBtn.textContent = "C 등급 일괄 확정 (" + undecidedC.length + "개)";
    $("goto-confirmed-btn").disabled = !complete;
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
    confirmBtn.textContent = "확정";
    confirmBtn.addEventListener("click", function () {
      applyDecision(candidate.id, "confirmed");
    });
    const rejectBtn = document.createElement("button");
    rejectBtn.textContent = "거절";
    rejectBtn.addEventListener("click", function () {
      applyDecision(candidate.id, "rejected");
    });
    row.appendChild(confirmBtn);
    row.appendChild(rejectBtn);
    card.appendChild(row);
    return card;
  }

  function applyDecision(candidateId, decision) {
    record = T.setDecision(record, candidateId, decision); // 유일한 전이 경로
    persist();
    renderGate1Screen();
  }

  // 일괄 확정 — 등급 C만. 이 화면은 후보 문장을 항상 전체로 보여준다(축약 없음)므로
  // "전체 문장을 보여준 상태" 조건이 항상 충족된다. B는 개별 탭으로만 확정된다.
  function batchConfirmC() {
    const targets = record.candidates.filter(function (c) {
      return c.grade === "C" && c.decision === "undecided";
    });
    for (const c of targets) {
      record = T.setDecision(record, c.id, "confirmed");
    }
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
    $("confirmed-count").textContent = "Confirmed " + facts.length + " · Rejected " + rejectedCount;

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
  }

  // ---------------------------------------------------------------
  // 교체 전이: 새 하루 / 샘플 로드 (병합이 아니라 완전 교체다)
  // ---------------------------------------------------------------

  function startNewDay() {
    record = T.createDayRecord(); // 이전 레코드와 병합 없음
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl);
      photoUrl = null;
    }
    photoFile = null;
    lastDebugText = "";
    persist();
    hideCaptureError();
    $("capture-notice").hidden = true;
    renderCaptureScreen();
    showScreen("screen-capture");
  }

  function loadSampleDay() {
    const base = Object.assign(T.createDayRecord(), {
      mode: "sample",
      memoText: SAMPLE_DAY.memo.text
    });
    const token = T.beginExtraction(base);
    record = T.applyExtraction(base, token, SAMPLE_DAY); // 샘플도 라이브와 같은 정규화 경로
    if (photoUrl) {
      URL.revokeObjectURL(photoUrl);
      photoUrl = null;
    }
    photoFile = null;
    lastDebugText = "";
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
    $("load-sample-btn").addEventListener("click", loadSampleDay);
    $("back-to-gate1-btn").addEventListener("click", function () {
      renderGate1Screen();
      showScreen("screen-gate1");
    });
    $("new-day-capture-btn").addEventListener("click", startNewDay);

    $("batch-confirm-btn").addEventListener("click", batchConfirmC);
    $("goto-confirmed-btn").addEventListener("click", function () {
      renderConfirmedScreen();
      showScreen("screen-confirmed");
    });
    $("edit-memo-btn").addEventListener("click", function () {
      renderCaptureScreen();
      showScreen("screen-capture");
    });
    $("new-day-gate1-btn").addEventListener("click", startNewDay);

    $("back-to-gate1-from-confirmed-btn").addEventListener("click", function () {
      renderGate1Screen();
      showScreen("screen-gate1");
    });
    $("new-day-confirmed-btn").addEventListener("click", startNewDay);
  }

  // ---------------------------------------------------------------
  // 시작: 저장 상태 복원
  // ---------------------------------------------------------------

  function init() {
    wireStaticHandlers();
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
