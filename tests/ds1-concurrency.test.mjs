// DS-1 acceptance tests (P0-1 concurrency, P0-2 invalidation, P1-2 entry guards).
//
// One command: node tests/ds1-concurrency.test.mjs
//
// The app is loaded into a vm with a fake DOM, fake storage and a deferred fetch
// stub. Each acceptance scenario reproduces the exact interleaving named in
// docs/audit-fix-packet.md:
//   1. page synthesis + testimony save       -> page is applied
//   2. page synthesis + stylization          -> both are applied
//   3. page synthesis + decision flip        -> page result is discarded
//   4. first extraction + photo replacement  -> extraction is discarded
//   5. briefing + question draft concurrently-> both are applied
// Plus the rest of DS-1:
//   - photo replacement clears old media (style image / data URL / style error)
//   - questionCard entry guards (preview + bedtime)
//   - enterBedtime LEAK guard
//   - runQuestionDraft persists the filtered premise IDs
//
// No live network calls. No fixture/golden output is read.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import TawCore from "../web/core.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const APP_PATH = path.join(ROOT, "web", "app.js");
const INDEX_PATH = path.join(ROOT, "web", "index.html");

const indexHtml = fs.readFileSync(INDEX_PATH, "utf8");
const INDEX_IDS = Array.from(indexHtml.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]);

// ---------------------------------------------------------------------------
// Fake DOM / storage / deferred responses
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.listeners = Object.create(null);
    this.hidden = false;
    this.disabled = false;
    this.readOnly = false;
    this.value = "";
    this.className = "";
    this.id = "";
    this.alt = "";
    this.src = "";
    this.files = null;
    this.width = 0;
    this.height = 0;
    this._text = "";
  }

  set textContent(value) {
    this._text = value === null || value === undefined ? "" : String(value);
    this.children = [];
  }

  get textContent() {
    return this._text;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  addEventListener(type, handler) {
    (this.listeners[type] || (this.listeners[type] = [])).push(handler);
  }

  click() {
    if (this.disabled) return;
    for (const handler of this.listeners.click || []) handler({ target: this });
  }

  trigger(type) {
    for (const handler of this.listeners[type] || []) handler({ target: this });
  }

  getContext() {
    return { drawImage() {} };
  }

  toDataURL() {
    return "data:image/jpeg;base64,UFJFUEFSRURQTEFDRUhPTERFUg==";
  }
}

function findDescendants(element, predicate, out = []) {
  for (const child of element.children || []) {
    if (predicate(child)) out.push(child);
    findDescendants(child, predicate, out);
  }
  return out;
}

function findButtonByText(root, text) {
  return findDescendants(root, (el) => el.tagName === "button" && el.textContent === text)[0] || null;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    async text() { return text; }
  };
}

function modelResponse(content, status = 200) {
  return textResponse(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }]
  }), status);
}

function classifyRequest(payload) {
  if (payload && typeof payload.prompt === "string" && Array.isArray(payload.images)) return "image";
  const messages = payload && Array.isArray(payload.messages) ? payload.messages : [];
  const system = messages[0] && typeof messages[0].content === "string" ? messages[0].content : "";
  if (system.indexOf("사진과 메모") !== -1) return "extraction";
  if (system.indexOf("취침 전 브리핑") !== -1) return "briefing";
  if (system.indexOf("취침 질문 카드") !== -1) return "question";
  if (system.indexOf("취침 그림책 페이지") !== -1) return "page";
  return "unknown";
}

function userJson(ctx) {
  const messages = ctx.payload.messages || [];
  const user = messages[1] && typeof messages[1].content === "string" ? messages[1].content : "";
  return JSON.parse(user);
}

function seedRecord(overrides) {
  return Object.assign(TawCore.createDayRecord(), {
    mode: "live",
    memoText: "오늘의 메모",
    candidates: [],
    unknowns: [],
    briefing: null,
    questionCard: null,
    pageSentences: [],
    testimony: []
  }, overrides);
}

function confirmedSeed(overrides) {
  return seedRecord(Object.assign({
    candidates: [
      { id: "F1", text: "아이가 강아지를 바라보았다", source: "photo", grade: "C", decision: "confirmed" },
      { id: "F2", text: "강아지가 아이 옆에 있었다", source: "photo", grade: "C", decision: "confirmed" },
      { id: "F3", text: "아이가 웃었다", source: "memo", grade: "B", decision: "rejected" }
    ],
    unknowns: [
      { id: "U1", text: "강아지의 이름은 무엇인가?" },
      { id: "U2", text: "강아지는 몇 살인가?" }
    ],
    briefing: [{ text: "아이는 강아지를 바라보았다.", factIds: ["F1"] }],
    pageSentences: [],
    testimony: []
  }, overrides));
}

function createApp(options = {}) {
  const storageMap = new Map();
  if (options.seed) {
    const json = TawCore.serialize(options.seed);
    if (json === null) throw new Error("시드 레코드를 직렬화할 수 없다");
    storageMap.set(TawCore.STORAGE_KEY, json);
  }

  const elements = new Map(INDEX_IDS.map((id) => [id, Object.assign(new FakeElement("div"), { id })]));
  const document = {
    getElementById(id) {
      if (elements.has(id)) return elements.get(id);
      for (const root of elements.values()) {
        const match = findDescendants(root, (el) => el.id === id)[0];
        if (match) return match;
      }
      return null;
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    }
  };

  const localStorage = {
    getItem(key) {
      return storageMap.has(key) ? storageMap.get(key) : null;
    },
    setItem(key, value) {
      storageMap.set(key, String(value));
    },
    removeItem(key) {
      storageMap.delete(key);
    }
  };

  const requests = [];
  const appFetch = async (url, fetchOptions = {}) => {
    const ctx = {
      url: String(url),
      body: fetchOptions.body,
      payload: JSON.parse(fetchOptions.body),
      kind: "unknown"
    };
    ctx.kind = classifyRequest(ctx.payload);
    requests.push(ctx);
    const result = options.onFetch ? await options.onFetch(ctx) : null;
    if (!result) throw new Error("스텁 응답이 없다: " + ctx.kind);
    return result;
  };

  const revokedUrls = [];
  const sandbox = {
    window: { TawCore, scrollTo() {} },
    document,
    localStorage,
    navigator: {},
    URL: {
      createObjectURL() { return "blob:ds1-session"; },
      revokeObjectURL(url) { revokedUrls.push(url); }
    },
    fetch: appFetch,
    createImageBitmap: options.createImageBitmap || (async () => ({ width: 32, height: 24, close() {} })),
    setTimeout,
    clearTimeout,
    Set,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_PATH, "utf8"), sandbox, { filename: "web/app.js" });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  return {
    requests,
    revokedUrls,
    click(id) {
      document.getElementById(id).click();
    },
    setValue(id, value) {
      document.getElementById(id).value = value;
    },
    trigger(id, type) {
      document.getElementById(id).trigger(type);
    },
    setPhoto(file) {
      const input = document.getElementById("photo-input");
      input.files = file ? [file] : null;
      input.trigger("change");
    },
    element(id) {
      return document.getElementById(id);
    },
    current() {
      const raw = localStorage.getItem(TawCore.STORAGE_KEY);
      if (raw === null) return null;
      return JSON.parse(raw);
    },
    async flush() {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      await sleep(0);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
    async waitFor(predicate, label, timeoutMs = 3000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate()) return true;
        await sleep(5);
      }
      throw new Error("대기 시간 초과: " + label);
    }
  };
}

// ---------------------------------------------------------------------------
// Assertion runner
// ---------------------------------------------------------------------------

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail: detail || "" });
}

async function scenario(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(name + " (실행)", false, err && err.message ? err.message : String(err));
  }
}

const extractionCandidates = {
  candidates: [
    { id: "F1", text: "아이가 강아지를 바라보았다", source: "photo", grade: "C" },
    { id: "F2", text: "강아지가 아이 옆에 있었다", source: "photo", grade: "C" }
  ],
  unknowns: ["강아지의 이름은 무엇인가?"]
};

function briefingFromRequest(ctx) {
  const facts = userJson(ctx);
  return modelResponse({ lines: [{ text: "브리핑 문장", factIds: [facts[0].id] }] });
}

function pageFromRequest(ctx) {
  const facts = userJson(ctx);
  return modelResponse({ sentences: [{ text: "페이지 문장", factIds: [facts[0].id] }] });
}

async function extractAndConfirm(app, options = {}) {
  if (!options.keepPhoto) {
    app.setPhoto({ name: "day.jpg", size: 1024, type: "image/jpeg" });
  }
  app.setValue("memo-input", "강아지와 놀았다");
  app.trigger("memo-input", "input");
  app.click("extract-btn");
  await app.waitFor(() => {
    const rec = app.current();
    return rec && rec.candidates.length > 0;
  }, "추출 결과 저장");
  app.click("batch-confirm-btn");
  app.click("goto-confirmed-btn");
}

// ---------------------------------------------------------------------------
// ① 페이지 합성 중 증언 저장 → 페이지 적용
// ---------------------------------------------------------------------------

await scenario("01 page synthesis + testimony save", async () => {
  const page = deferred();
  const app = createApp({
    seed: confirmedSeed(),
    onFetch(ctx) {
      if (ctx.kind === "page") return page.promise;
      if (ctx.kind === "briefing") return briefingFromRequest(ctx);
      return textResponse("{}", 500);
    }
  });

  app.click("goto-confirmed-btn");
  app.click("open-preview-btn");
  app.click("open-bedtime-btn");
  await app.waitFor(() => app.requests.some((r) => r.kind === "page"), "페이지 요청 시작");

  app.setValue("testimony-input", "오늘은 강아지가 따라왔다");
  app.click("save-testimony-btn");

  page.resolve(modelResponse({
    sentences: [{ text: "아이는 강아지를 바라보았다.", factIds: ["F1"] }]
  }));
  await app.waitFor(() => {
    const rec = app.current();
    return rec && rec.pageSentences.some((s) => s.text === "아이는 강아지를 바라보았다.");
  }, "페이지 적용");

  const rec = app.current();
  check("01 페이지 합성 결과가 적용됨", rec.pageSentences.length === 1, JSON.stringify(rec.pageSentences));
  check("01 증언도 함께 보존됨", rec.testimony.some((e) => e.text === "오늘은 강아지가 따라왔다"),
    JSON.stringify(rec.testimony));
});

// ---------------------------------------------------------------------------
// ② 페이지 합성 중 스타일화 → 둘 다 적용
// ---------------------------------------------------------------------------

for (const first of ["page", "image"]) {
await scenario("02 page synthesis + stylization (" + first + " first)", async () => {
  const page = deferred();
  const image = deferred();
  const app = createApp({
    onFetch(ctx) {
      if (ctx.kind === "extraction") return modelResponse(extractionCandidates);
      if (ctx.kind === "briefing") return briefingFromRequest(ctx);
      if (ctx.kind === "page") return page.promise;
      if (ctx.kind === "image") return image.promise;
      return textResponse("{}", 500);
    }
  });

  await extractAndConfirm(app);
  app.click("open-preview-btn");
  await app.waitFor(() => {
    const rec = app.current();
    return rec && rec.briefing && rec.briefing.length > 0;
  }, "브리핑 적용");
  app.click("open-bedtime-btn");
  await app.waitFor(() => app.requests.some((r) => r.kind === "page"), "페이지 요청 시작");

  const stylize = app.element("stylize-btn");
  check("02 스타일화 버튼이 렌더됨", !!stylize);
  if (stylize) stylize.click();
  await app.waitFor(() => app.requests.some((r) => r.kind === "image"), "스타일화 요청 시작");

  const resolvePage = () => page.resolve(modelResponse({
    sentences: [{ text: "페이지 문장", factIds: ["F1"] }]
  }));
  const resolveImage = () => image.resolve(textResponse(JSON.stringify({ data: [{ b64_json: "U1RZTEVJTUdEQVRB" }] })));
  (first === "page" ? resolvePage : resolveImage)();
  await app.flush();
  (first === "page" ? resolveImage : resolvePage)();

  await app.waitFor(() => {
    const rec = app.current();
    return rec && rec.pageSentences.length === 1 && rec.pageSentences[0].text === "페이지 문장";
  }, "페이지 + 스타일화 완료");
  await app.flush();

  const images = findDescendants(app.element("bedtime-image-area"), (el) => el.tagName === "img");
  const rec = app.current();
  check("02 페이지 합성이 적용됨", rec.pageSentences[0].text === "페이지 문장", JSON.stringify(rec.pageSentences));
  check("02 스타일화 이미지가 적용됨",
    images.some((img) => img.src === "data:image/png;base64,U1RZTEVJTUdEQVRB"),
    images.map((img) => img.src).join(","));
});
}

// ---------------------------------------------------------------------------
// ③ 페이지 합성 중 결정 뒤집기 → 결과 폐기
// ---------------------------------------------------------------------------

await scenario("03 page synthesis + decision flip", async () => {
  const page = deferred();
  const app = createApp({
    seed: confirmedSeed(),
    onFetch(ctx) {
      if (ctx.kind === "page") return page.promise;
      if (ctx.kind === "briefing") return briefingFromRequest(ctx);
      return textResponse("{}", 500);
    }
  });

  app.click("goto-confirmed-btn");
  app.click("open-preview-btn");
  app.click("open-bedtime-btn");
  await app.waitFor(() => app.requests.some((r) => r.kind === "page"), "페이지 요청 시작");

  // 취침 → 프리뷰 → 확정 목록 → Gate 1 으로 돌아가 결정을 뒤집는다.
  app.click("back-to-preview-btn");
  app.click("back-to-confirmed-btn");
  app.click("back-to-gate1-from-confirmed-btn");
  const reject = findButtonByText(app.element("candidate-list"), "거절");
  check("03 거절 버튼을 찾음", !!reject);
  if (reject) reject.click();

  const afterFlip = app.current();
  check("03 결정 뒤집기가 저장됨", afterFlip.candidates.some((c) => c.id === "F1" && c.decision === "rejected"),
    JSON.stringify(afterFlip.candidates));

  page.resolve(modelResponse({
    sentences: [{ text: "뒤집힌 결정 뒤에 도착한 페이지", factIds: ["F1"] }]
  }));
  await app.flush();

  const rec = app.current();
  check("03 늦은 페이지 결과가 폐기됨", rec.pageSentences.length === 0, JSON.stringify(rec.pageSentences));
});

// ---------------------------------------------------------------------------
// ④ 첫 추출 중 사진 교체 → 추출 폐기 (후보 0개에서도 토큰 무효화)
// ---------------------------------------------------------------------------

await scenario("04 first extraction + photo replacement", async () => {
  const extraction = deferred();
  const app = createApp({
    onFetch(ctx) {
      if (ctx.kind === "extraction") return extraction.promise;
      return textResponse("{}", 500);
    }
  });

  app.setPhoto({ name: "first.jpg", size: 10, type: "image/jpeg" });
  app.setValue("memo-input", "첫 사진 메모");
  app.trigger("memo-input", "input");
  app.click("extract-btn");
  await app.waitFor(() => app.requests.some((r) => r.kind === "extraction"), "첫 추출 요청 시작");

  // 후보가 아직 0개인 상태에서 사진을 교체한다.
  app.setPhoto({ name: "second.jpg", size: 11, type: "image/jpeg" });

  extraction.resolve(modelResponse(extractionCandidates));
  await app.flush();

  const rec = app.current();
  check("04 사진 교체 후 첫 추출 결과가 폐기됨", rec.candidates.length === 0, JSON.stringify(rec.candidates));
  check("04 메모는 새 레코드에 남음", rec.memoText === "첫 사진 메모", rec.memoText);
  check("04 사진 교체 상태가 갱신됨",
    String(app.element("photo-status").textContent) !== "",
    app.element("photo-status").textContent);
  check("04 실패 배너가 뜨지 않음", app.element("capture-error").hidden === true,
    app.element("capture-error").textContent);
});

// ---------------------------------------------------------------------------
// ⑤ 브리핑 + 질문 초안 동시 → 둘 다 적용
// ---------------------------------------------------------------------------

for (const first of ["briefing", "question"]) {
await scenario("05 briefing + question draft concurrently (" + first + " first)", async () => {
  const briefing = deferred();
  const question = deferred();
  const app = createApp({
    seed: confirmedSeed({ briefing: null }),
    onFetch(ctx) {
      if (ctx.kind === "briefing") return briefing.promise;
      if (ctx.kind === "question") return question.promise;
      return textResponse("{}", 500);
    }
  });

  app.click("goto-confirmed-btn");
  app.click("open-preview-btn");
  await app.waitFor(() => app.requests.some((r) => r.kind === "briefing"), "브리핑 요청 시작");

  app.click("draft-btn");
  await app.waitFor(() => app.requests.some((r) => r.kind === "question"), "질문 초안 요청 시작");

  const resolveBriefing = () => briefing.resolve(modelResponse({
    lines: [{ text: "브리핑 문장", factIds: ["F1"] }]
  }));
  const resolveQuestion = () => question.resolve(modelResponse({ text: "오늘 강아지는 어땠어?" }));
  (first === "briefing" ? resolveBriefing : resolveQuestion)();
  await app.flush();
  (first === "briefing" ? resolveQuestion : resolveBriefing)();

  await app.waitFor(() => {
    const rec = app.current();
    return rec && rec.briefing && rec.briefing.length > 0 && rec.questionCard;
  }, "브리핑 + 질문 초안 적용");

  const rec = app.current();
  check("05 브리핑이 적용됨", rec.briefing[0].text === "브리핑 문장", JSON.stringify(rec.briefing));
  check("05 질문 초안이 적용됨", rec.questionCard.text === "오늘 강아지는 어땠어?",
    JSON.stringify(rec.questionCard));
});
}

// ---------------------------------------------------------------------------
// P0-2a 사진 교체 시 구 미디어 상태 초기화
// ---------------------------------------------------------------------------

await scenario("06 photo replacement clears media state", async () => {
  const oldImage = deferred();
  const app = createApp({
    onFetch(ctx) {
      if (ctx.kind === "extraction") return modelResponse(extractionCandidates);
      if (ctx.kind === "briefing") return briefingFromRequest(ctx);
      if (ctx.kind === "page") return pageFromRequest(ctx);
      if (ctx.kind === "image") return oldImage.promise;
      return textResponse("{}", 500);
    }
  });

  // 1) 첫 사진으로 추출 → 확정 → 취침 → 스타일화 성공.
  await extractAndConfirm(app);
  app.click("open-preview-btn");
  await app.waitFor(() => {
    const rec = app.current();
    return rec && rec.briefing && rec.briefing.length > 0;
  }, "첫 브리핑 적용");
  app.click("open-bedtime-btn");
  await app.waitFor(() => {
    const rec = app.current();
    return rec && rec.pageSentences.length > 0;
  }, "첫 페이지 적용");
  app.element("stylize-btn").click();
  await app.waitFor(() => app.requests.some((r) => r.kind === "image"), "첫 스타일화 요청");
  oldImage.resolve(textResponse(JSON.stringify({ data: [{ b64_json: "T0xEU1RZTEU=" }] })));
  await app.waitFor(() => {
    const images = findDescendants(app.element("bedtime-image-area"), (el) => el.tagName === "img");
    return images.some((img) => img.src === "data:image/png;base64,T0xEU1RZTEU=");
  }, "첫 스타일화 이미지 표시");

  // 2) 사진 교체 — 구 세션 미디어가 전부 폐기되어야 한다.
  app.setPhoto({ name: "replacement.jpg", size: 12, type: "image/jpeg" });
  check("06 구 스타일화 URL revoke", app.revokedUrls.includes("data:image/png;base64,T0xEU1RZTEU="));

  // 3) 새 사진으로 다시 추출·확정·취침 — 이전 스타일화 그림이 서빙되면 실패.
  await extractAndConfirm(app, { keepPhoto: true });
  app.click("open-preview-btn");
  await app.waitFor(() => {
    const rec = app.current();
    return rec && rec.briefing && rec.briefing.length > 0;
  }, "새 브리핑 적용");
  app.click("open-bedtime-btn");
  await app.waitFor(() => {
    const rec = app.current();
    return rec && rec.pageSentences.length > 0;
  }, "새 페이지 적용");

  const images = findDescendants(app.element("bedtime-image-area"), (el) => el.tagName === "img");
  const stylize = app.element("stylize-btn");
  check("06 구 스타일화 이미지가 새 사진에 서빙되지 않음",
    !images.some((img) => img.src === "data:image/png;base64,T0xEU1RZTEU="),
    images.map((img) => img.src).join(","));
  check("06 새 사진의 스타일화 버튼이 열려 있음", !!stylize && stylize.disabled === false);
});

// ---------------------------------------------------------------------------
// P1-2 enterPreview / enterBedtime questionCard 가드
// ---------------------------------------------------------------------------

await scenario("07 questionCard entry guard (preview)", async () => {
  const app = createApp({
    seed: confirmedSeed({
      questionCard: {
        text: "오래된 질문",
        unknownId: "U9", // 현재 unknowns에 없음
        premiseFactIds: ["F3"] // rejected — 확정 집합 밖
      }
    }),
    onFetch(ctx) {
      if (ctx.kind === "briefing") return briefingFromRequest(ctx);
      return textResponse("{}", 500);
    }
  });

  app.click("goto-confirmed-btn");
  app.click("open-preview-btn");
  await app.flush();

  const rec = app.current();
  check("07 잘못된 questionCard가 프리뷰 진입에서 폐기됨", rec.questionCard === null,
    JSON.stringify(rec.questionCard));
  check("07 질문 입력이 비워짐", app.element("question-text").value === "",
    app.element("question-text").value);
});

await scenario("08 questionCard entry guard + LEAK guard (bedtime)", async () => {
  const page = deferred();
  const app = createApp({
    seed: confirmedSeed({
      questionCard: {
        text: "오래된 질문",
        unknownId: "U9",
        premiseFactIds: ["F1"]
      },
      // F1 원문에 없는 "행복" — checkLeaks 위반.
      pageSentences: [{ text: "아이가 행복하게 웃었다", factIds: ["F1"] }]
    }),
    onFetch(ctx) {
      if (ctx.kind === "page") return page.promise;
      return textResponse("{}", 500);
    }
  });

  // 프리뷰를 거치지 않고 취침 진입 자체를 검사한다.
  app.click("open-bedtime-btn");
  await app.waitFor(() => app.requests.some((r) => r.kind === "page"), "LEAK 폐기 후 재합성 요청");

  const during = app.current();
  check("08 취침 진입에서 잘못된 questionCard가 폐기됨", during.questionCard === null,
    JSON.stringify(during.questionCard));
  check("08 LEAK 위반 pageSentences가 폐기됨", during.pageSentences.length === 0,
    JSON.stringify(during.pageSentences));

  page.resolve(modelResponse({
    sentences: [{ text: "새 페이지 문장", factIds: ["F1"] }]
  }));
  await app.waitFor(() => {
    const rec = app.current();
    return rec && rec.pageSentences.some((s) => s.text === "새 페이지 문장");
  }, "LEAK 폐기 후 재합성 적용");
  check("08 재합성 페이지가 적용됨", true);
});

// ---------------------------------------------------------------------------
// P1-2 runQuestionDraft — 필터링된 전제 저장
// ---------------------------------------------------------------------------

await scenario("09 question draft persists filtered premises", async () => {
  const question = deferred();
  const app = createApp({
    seed: confirmedSeed(),
    onFetch(ctx) {
      if (ctx.kind === "question") return question.promise;
      if (ctx.kind === "briefing") return briefingFromRequest(ctx);
      return textResponse("{}", 500);
    }
  });

  app.click("goto-confirmed-btn");
  app.click("open-preview-btn");
  const chip = findDescendants(app.element("premise-chips"), (el) => String(el.textContent).startsWith("F1 ·"))[0];
  check("09 전제 칩을 찾음", !!chip);
  if (chip) chip.click();

  app.click("draft-btn");
  await app.waitFor(() => app.requests.some((r) => r.kind === "question"), "질문 초안 요청 시작");
  const request = app.requests.find((r) => r.kind === "question");
  const sent = userJson(request).premiseFacts.map((f) => f.id);

  // 요청 뒤 선택이 바뀌어도 저장할 전제는 실제 요청에 실린 목록이어야 한다.
  const otherChip = findDescendants(app.element("premise-chips"), (el) => String(el.textContent).startsWith("F2 ·"))[0];
  if (!otherChip) throw new Error("F2 전제 칩이 없다");
  otherChip.click();

  question.resolve(modelResponse({ text: "강아지 이름은 뭐야?" }));
  await app.waitFor(() => {
    const rec = app.current();
    return rec && rec.questionCard;
  }, "질문 카드 저장");

  const rec = app.current();
  check("09 요청에 실린 전제는 F1 하나", sent.length === 1 && sent[0] === "F1", JSON.stringify(sent));
  check("09 저장된 전제도 필터링 결과와 일치",
    rec.questionCard.premiseFactIds.length === 1 && rec.questionCard.premiseFactIds[0] === "F1",
    JSON.stringify(rec.questionCard.premiseFactIds));
});

// 독립 작업이 레코드를 교체한 뒤에도 다른 작업의 실패 배너는 유지된다.
for (const failing of ["briefing", "question"]) {
await scenario("10 independent " + failing + " error", async () => {
  const briefing = deferred();
  const question = deferred();
  const app = createApp({
    seed: confirmedSeed({ briefing: null }),
    onFetch(ctx) {
      if (ctx.kind === "briefing") return briefing.promise;
      if (ctx.kind === "question") return question.promise;
      return textResponse("{}", 500);
    }
  });
  app.click("open-preview-btn");
  app.click("draft-btn");
  const successful = failing === "briefing" ? question : briefing;
  successful.resolve(modelResponse(failing === "briefing"
    ? { text: "저장할 질문" }
    : { lines: [{ text: "저장할 브리핑", factIds: ["F1"] }] }));
  await app.flush();
  (failing === "briefing" ? briefing : question).reject(new Error("independent failure"));
  await app.flush();
  check("10 " + failing + " 오류 표시", !app.element("preview-error").hidden);
  const rec = app.current();
  check("10 독립 성공 결과 보존", failing === "briefing"
    ? rec.questionCard?.text === "저장할 질문"
    : rec.briefing?.[0].text === "저장할 브리핑");
});
}

for (const event of ["memo", "photo", "decision", "new-day", "sample"]) {
await scenario("11 all pending results discarded on " + event, async () => {
  const pending = { briefing: deferred(), question: deferred(), page: deferred() };
  const app = createApp({
    seed: confirmedSeed({ briefing: null }),
    onFetch(ctx) { return pending[ctx.kind]?.promise || textResponse("{}", 500); }
  });
  app.click("open-preview-btn");
  app.click("draft-btn");
  app.click("open-bedtime-btn");
  if (event === "memo") {
    app.setValue("memo-input", "새 메모");
    app.trigger("memo-input", "input");
  } else if (event === "photo") {
    app.setPhoto({ name: "new.jpg", size: 10 });
  } else if (event === "decision") {
    app.click("back-to-gate1-from-confirmed-btn");
    findButtonByText(app.element("candidate-list"), "거절").click();
  } else {
    app.click(event === "sample" ? "load-sample-btn" : "new-day-confirm-start-btn");
  }
  const before = JSON.stringify(app.current());
  pending.briefing.resolve(modelResponse({ lines: [{ text: "낡은 브리핑", factIds: ["F1"] }] }));
  pending.question.resolve(modelResponse({ text: "낡은 질문" }));
  // 무효화 이후의 실패도 배너/디버그에 나타나면 안 된다.
  pending.page.resolve(textResponse("stale malformed response"));
  await app.flush();
  check("11 " + event + " 뒤 저장 상태 불변", JSON.stringify(app.current()) === before);
  check("11 " + event + " 뒤 오류/디버그 없음", app.element("bedtime-error").hidden && app.element("bedtime-debug").hidden);
});
}

await scenario("12 old extraction finalizer cannot unlock new request", async () => {
  const old = deferred();
  const fresh = deferred();
  let count = 0;
  const app = createApp({
    onFetch() { return (++count === 1 ? old : fresh).promise; }
  });
  app.setPhoto({ name: "old.jpg", size: 10 });
  app.setValue("memo-input", "메모");
  app.trigger("memo-input", "input");
  app.click("extract-btn");
  await app.waitFor(() => count === 1, "구 추출");
  app.setPhoto({ name: "new.jpg", size: 10 });
  app.click("extract-btn");
  await app.waitFor(() => count === 2, "새 추출");
  old.reject(new Error("stale extraction"));
  await app.flush();
  check("12 새 추출의 버튼 잠금 유지", app.element("extract-btn").disabled);
  check("12 구 추출 오류 폐기", app.element("capture-error").hidden);
  fresh.resolve(modelResponse(extractionCandidates));
  await app.waitFor(() => app.current()?.candidates.length === 2, "새 추출 적용");
});

await scenario("13 photo replacement during decoding", async () => {
  const bitmap = deferred();
  const app = createApp({ createImageBitmap: () => bitmap.promise });
  app.setPhoto({ name: "old.jpg", size: 10 });
  app.setValue("memo-input", "메모");
  app.trigger("memo-input", "input");
  app.click("extract-btn");
  app.setPhoto({ name: "new.jpg", size: 10 });
  bitmap.resolve({ width: 32, height: 24, close() {} });
  await app.flush();
  check("13 구 사진 data URL로 추출하지 않음", app.requests.length === 0);
  check("13 후보 없음", app.current().candidates.length === 0);
});

for (const entry of ["open-preview-btn", "open-bedtime-btn"]) {
for (const kind of ["premise", "unknown", "valid"]) {
await scenario("14 question guard " + entry + " " + kind, async () => {
  const card = {
    text: "저장된 질문", unknownId: kind === "unknown" ? "U9" : "U1",
    premiseFactIds: kind === "premise" ? ["F3"] : ["F1"]
  };
  const app = createApp({ seed: confirmedSeed({
    questionCard: card,
    pageSentences: [{ text: "아이가 강아지를 바라보았다", factIds: ["F1"] }]
  }) });
  app.click(entry);
  check("14 " + entry + " " + kind, kind === "valid"
    ? JSON.stringify(app.current().questionCard) === JSON.stringify(card)
    : app.current().questionCard === null);
  check("14 불필요한 합성 없음", app.requests.length === 0);
});
}
}

await scenario("15 photo replacement clears style errors and raw snippets", async () => {
  const app = createApp({
    onFetch(ctx) {
      if (ctx.kind === "extraction") return modelResponse(extractionCandidates);
      if (ctx.kind === "briefing") return briefingFromRequest(ctx);
      if (ctx.kind === "page") return pageFromRequest(ctx);
      if (ctx.kind === "image") return textResponse('{"oldStyleError":true}');
      return textResponse("{}", 500);
    }
  });
  async function bedtime() {
    app.click("open-preview-btn");
    await app.waitFor(() => app.current()?.briefing?.length > 0, "브리핑");
    app.click("open-bedtime-btn");
    await app.waitFor(() => app.current()?.pageSentences.length > 0, "페이지");
    await app.flush();
  }
  await extractAndConfirm(app);
  await bedtime();
  app.click("stylize-btn");
  await app.flush();
  const errors = () => findDescendants(app.element("bedtime-image-area"),
    (el) => el.className === "error" || el.className === "debug");
  check("15 스타일화 오류와 원문 재현", errors().length === 2);
  app.setPhoto({ name: "new.jpg", size: 10 });
  await extractAndConfirm(app, { keepPhoto: true });
  await bedtime();
  check("15 구 스타일화 오류와 원문 제거", errors().length === 0);
  check("15 새 사진 스타일화 가능", app.element("stylize-btn")?.disabled === false);
});

await scenario("16 repeated decision is not an invalidation event", async () => {
  const page = deferred();
  const app = createApp({ seed: confirmedSeed(), onFetch: () => page.promise });
  app.click("open-bedtime-btn");
  app.click("back-to-gate1-from-confirmed-btn");
  findButtonByText(app.element("candidate-list"), "확정").click();
  page.resolve(modelResponse({ sentences: [{ text: "페이지 문장", factIds: ["F1"] }] }));
  await app.flush();
  check("16 같은 결정 재클릭 뒤 합성 결과 보존", app.current().pageSentences[0]?.text === "페이지 문장");
});

for (const entry of ["open-preview-btn", "open-bedtime-btn"]) {
await scenario("17 restricted question guard " + entry, async () => {
  const app = createApp({ seed: seedRecord({
    questionCard: { text: "낡은 질문", unknownId: "U1", premiseFactIds: ["F1"] }
  }) });
  app.click(entry);
  check("17 " + entry + " 제한 모드에서도 카드 폐기", app.current().questionCard === null);
  check("17 제한 모드 합성 없음", app.requests.length === 0);
});
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let failed = 0;
for (const result of results) {
  const status = result.ok ? "PASS" : "FAIL";
  if (!result.ok) failed += 1;
  console.log(status + " " + result.name + (result.detail ? " | " + result.detail : ""));
}
console.log("\n" + (results.length - failed) + "/" + results.length + " checks passed");
if (failed > 0) process.exitCode = 1;
