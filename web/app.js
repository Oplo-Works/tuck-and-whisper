// Tuck & Whisper — S1b 화면 층: Capture / Gate 1 / 확정 목록
// 상태 전이는 전부 core.js(TawCore)의 함수로만 한다. 이 파일은 렌더링과 이벤트만 담당한다.
// 모델이 만든 텍스트는 전부 textContent로 넣는다 (innerHTML 금지). 화면당 렌더 함수 1개.

(function () {
  "use strict";

  const T = window.TawCore;

  // 실제 아이 사진은 레포에 절대 넣지 않는다 (레포 밖 또는 local-media/ 만).
  // 사진 파일 경로가 필요해지면 이 상수 한 곳만 고친다. null인 동안은 항상 플레이스홀더.
  const PHOTO_PATH = null;

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

  // --- 상태 (모듈 변수 2개가 전부다) ---
  let record = T.createDayRecord(); // 모든 전이는 core 함수로만
  let photoFile = null;             // 메모리 전용 — serialize 화이트리스트 밖, 저장 안 됨

  function $(id) { return document.getElementById(id); }

  // --- 화면 전환 (단일 헬퍼) ---
  const SCREENS = ["screen-capture", "screen-gate1", "screen-confirmed"];
  function showScreen(id) {
    for (const sid of SCREENS) {
      $(sid).hidden = sid !== id;
    }
    window.scrollTo(0, 0);
  }

  // --- 저장/복원 — core serialize/restore + core.STORAGE_KEY 만 사용 ---
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
    // 브리프: 사진과 메모가 모두 있을 때만 활성화
    const hasPhoto = photoFile !== null;
    const hasMemo = $("memo-input").value.trim() !== "";
    $("extract-btn").disabled = !(hasPhoto && hasMemo);
  }

  // 무효화 규칙: 추출 결과가 있는 상태에서 메모가 바뀌면 전부 비운다 (core.invalidateExtraction).
  function onMemoInput() {
    const text = $("memo-input").value;
    if (record.candidates.length > 0 || record.unknowns.length > 0) {
      record = Object.assign(T.invalidateExtraction(record), { memoText: text });
      $("capture-notice").textContent = "메모가 바뀌어 이전 추출 결과(후보·결정)를 전부 무효화했다.";
      $("capture-notice").hidden = false;
      $("back-to-gate1-btn").hidden = true;
    } else {
      record = Object.assign({}, record, { memoText: text });
    }
    persist();
    updateExtractButton();
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
    } else if (PHOTO_PATH) {
      const img = document.createElement("img");
      img.className = "photo-thumb";
      img.alt = "오늘의 사진";
      img.src = PHOTO_PATH; // 사진 경로는 PHOTO_PATH 상수 한 곳에서만 관리
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
    photoFile = null;
    persist();
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
    photoFile = null;
    persist();
    renderGate1Screen();
    showScreen("screen-gate1");
  }

  // ---------------------------------------------------------------
  // 정적 버튼 연결 (1회)
  // ---------------------------------------------------------------

  function wireStaticHandlers() {
    $("photo-input").addEventListener("change", function () {
      photoFile = this.files && this.files[0] ? this.files[0] : null;
      renderCaptureScreen();
    });
    $("memo-input").addEventListener("input", onMemoInput);
    $("extract-btn").addEventListener("click", function () {
      // 이 단계에는 API가 없다 (라이브 Spark는 다음 단계)
      const notice = $("capture-notice");
      notice.textContent = "라이브 추출(Spark)은 다음 단계에서 연결된다. 지금은 Load sample day로 흐름을 확인할 수 있다.";
      notice.hidden = false;
    });
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

  // 서비스 워커 등록 — 스켈레톤과 동일 동작. sw.js 파일 자체는 이 단계에서 건드리지 않는다.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
})();
