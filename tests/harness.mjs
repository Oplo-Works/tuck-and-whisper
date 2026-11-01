// S7 — Counterfactual harness (spec frozen 2026-10-31)
//
// One command: node tests/harness.mjs
//
// What this file is:
//   - Check 1: citation integrity. Every served sentence must cite only facts in the
//     fixture-derived confirmed set, must cite at least one fact, and every cited id
//     must exist in the fixture candidates. The PASS/FAIL oracle is implemented here,
//     not imported from the app. The app's validator is only called as a subject in a
//     counterfactual gate probe.
//   - Check 2: unconfirmed facts have no influence. The deterministic layer CAPTURES
//     the synthesis input before any output exists and compares it with the fixture's
//     confirmed set, then adds an undecided marker candidate and captures again.
//     The live layer also captures the facts list in every real Worker request.
//   - Check 3: correction/version integrity. v1 is the pre-correction persisted state.
//     The legal path (edit memo -> invalidate -> re-extract -> reconfirm -> recompose)
//     must produce a new fact id, a new page version, leave v1 byte-identical, and
//     serve v2 as current.
//
// Independence rules enforced here:
//   - Expected values come only from fixtures/deuri-day.json and the frozen spec.
//   - No golden file captured from app output is read or written.
//   - The fixture file is read-only; every state change is an in-memory copy.
//   - PASS/FAIL is decided by the local oracle below. TawCore.validateComposition is
//     never used as the oracle; it is only observed as a subject where noted.
//
// Live layer:
//   web/app.js is run unmodified in an in-memory DOM (vm). The harness drives the
//   real UI handlers, so the real prompts, retry loop, token guard, fallback, Worker
//   request shape and localStorage persistence are exercised. Requests go to the
//   real Worker (https://taw-meta-proxy.minkyuthebuilder.workers.dev) with the
//   required Origin header. Only the final served briefing/page is judged.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import TawCore from "../web/core.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURE_PATH = path.join(ROOT, "fixtures", "deuri-day.json");
const APP_PATH = path.join(ROOT, "web", "app.js");
const INDEX_PATH = path.join(ROOT, "web", "index.html");
const CORE_TEST_PATH = path.join(ROOT, "tests", "core.test.mjs");
const WORKER_URL = "https://taw-meta-proxy.minkyuthebuilder.workers.dev";
const ORIGIN = "https://tuck-and-whisper.pages.dev";
const LIVE_TIMEOUT_MS = 180_000;
const LIVE_ATTEMPTS = 2;

const fixtureBytes = fs.readFileSync(FIXTURE_PATH);
const fixtureHashBefore = sha256Hex(fixtureBytes);
const fixture = JSON.parse(fixtureBytes.toString("utf8"));

// ---------------------------------------------------------------------------
// Fixture-derived expected values (the only allowed source of expectations)
// ---------------------------------------------------------------------------

const fixtureCandidates = fixture.candidates;
const factById = new Map(fixtureCandidates.map((c) => [c.id, c]));
const allFixtureIds = new Set(fixtureCandidates.map((c) => c.id));
const expectedConfirmedIds = fixture.exampleState.confirmed.slice();
const expectedRejectedIds = fixture.exampleState.rejected.slice();

const F6 = factById.get("F6");
const F10 = factById.get("F10");
if (!F6 || !F10) {
  fatal("fixture가 F6/F10을 포함하지 않는다 — 기준 픽스처가 아니다.");
}
if (expectedConfirmedIds.length !== 12) {
  fatal("exampleState.confirmed가 12개가 아니다: " + expectedConfirmedIds.length);
}
if (expectedConfirmedIds.includes("F6")) {
  fatal("exampleState.confirmed에 거절된 F6가 들어 있다.");
}
if (!expectedRejectedIds.includes("F6")) {
  fatal("exampleState.rejected에 F6가 없다.");
}
for (const id of expectedConfirmedIds) {
  if (!factById.has(id)) fatal("exampleState.confirmed의 ID가 candidates에 없다: " + id);
}

const expectedConfirmedFacts = expectedConfirmedIds.map((id) => ({
  id,
  text: factById.get(id).text
}));
const expectedConfirmedSet = new Set(expectedConfirmedIds);

// F6 markers are derived from the F6 fact text itself, never from app output.
// "무릎", "코/입", and the contact claim are the three frozen spec markers.
const F6_MARKERS = [
  { name: "무릎", test: (text) => text.includes("무릎") },
  { name: "코/입", test: (text) => text.includes("코/입") },
  {
    name: "코와 입",
    test: (text) => /코\s*(?:와|과|\/)\s*입/.test(text)
  },
  { name: "닿아 있음(접촉)", test: (text) => text.includes("닿") || text.includes("접촉") }
];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonFacts(facts) {
  return facts
    .map((f) => ({ id: f.id, text: f.text }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function sameFacts(a, b) {
  return JSON.stringify(canonFacts(a)) === JSON.stringify(canonFacts(b));
}

function projection(facts) {
  return facts.map((f) => ({ id: f.id, text: f.text }));
}

function sameIdSet(ids, expectedIds) {
  const actual = Array.from(new Set(ids)).sort();
  const expected = Array.from(new Set(expectedIds)).sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function confirmedFromRecord(record) {
  // Independent derivation for harness-built v2 state. This intentionally does not
  // call TawCore.confirmedFacts / synthesisFacts.
  return record.candidates
    .filter((c) => c && c.decision === "confirmed")
    .map((c) => ({ id: c.id, text: c.text }));
}

function firstFreeFactId(usedIds) {
  let n = 1;
  while (usedIds.has("F" + n)) n += 1;
  return "F" + n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fatal(message) {
  console.error("[S7] FATAL: " + message);
  process.exit(1);
}

function log(message = "") {
  console.log(message);
}

// ---------------------------------------------------------------------------
// Local citation oracle (independent of web/core.js validateComposition)
// ---------------------------------------------------------------------------

function auditSentences(label, sentences, allowedIds, existingIds) {
  const violations = [];
  if (!Array.isArray(sentences)) {
    violations.push({
      where: label,
      reason: "문장 배열이 아니다",
      text: ""
    });
    return violations;
  }
  sentences.forEach((sentence, index) => {
    const where = label + " 문장 " + (index + 1);
    if (!sentence || typeof sentence !== "object" || typeof sentence.text !== "string" ||
        sentence.text.trim() === "") {
      violations.push({ where, reason: "형식이 깨진 문장이다", text: "" });
      return;
    }
    if (!Array.isArray(sentence.factIds) || sentence.factIds.length === 0) {
      violations.push({ where, reason: "factIds가 비어 있다", text: sentence.text });
      return;
    }
    const badType = sentence.factIds.filter((id) => typeof id !== "string" || id.trim() === "");
    if (badType.length > 0) {
      violations.push({
        where,
        reason: "factIds에 문자열이 아닌 ID가 있다",
        text: sentence.text
      });
      return;
    }
    const nonexistent = sentence.factIds.filter((id) => !existingIds.has(id));
    if (nonexistent.length > 0) {
      violations.push({
        where,
        reason: "픽스처 candidates에 없는 ID를 인용했다: " + nonexistent.join(", "),
        text: sentence.text
      });
    }
    const notConfirmed = sentence.factIds.filter((id) => !allowedIds.has(id));
    if (notConfirmed.length > 0) {
      violations.push({
        where,
        reason: "기대 확정 집합 밖의 ID를 인용했다: " + notConfirmed.join(", "),
        text: sentence.text
      });
    }
  });
  return violations;
}

function printSentences(label, sentences) {
  if (!Array.isArray(sentences)) {
    log("    " + label + ": (배열 아님)");
    return;
  }
  log("    " + label + " (" + sentences.length + "문장):");
  sentences.forEach((sentence, index) => {
    const ids = sentence && Array.isArray(sentence.factIds) ? sentence.factIds.join(",") : "?";
    const text = sentence && typeof sentence.text === "string" ? sentence.text : "(깨진 문장)";
    log("      " + (index + 1) + ". [" + ids + "] " + text);
  });
}

function printViolations(violations) {
  for (const v of violations) {
    log("    - " + v.where + ": " + v.reason + (v.text ? " | \"" + v.text + "\"" : ""));
  }
}

// ---------------------------------------------------------------------------
// Harness-built states (all are in-memory; the fixture is never written)
// ---------------------------------------------------------------------------

function buildFixtureRecord() {
  const base = Object.assign(TawCore.createDayRecord(), {
    mode: "live",
    memoText: fixture.memo.text
  });
  const token = TawCore.beginExtraction(base);
  let record = TawCore.applyExtraction(base, token, {
    candidates: deepClone(fixture.candidates),
    unknowns: deepClone(fixture.unknowns)
  });
  for (const candidate of record.candidates) {
    const decision = candidate.id === "F6" ? "rejected" : "confirmed";
    record = TawCore.setDecision(record, candidate.id, decision);
  }
  return record;
}

function stubComposition(facts) {
  // Recording stub composer, allowed by the deterministic layer of check 3.
  // It only records the confirmed facts it was given.
  return {
    briefing: facts.map((f) => ({ text: f.text, factIds: [f.id] })),
    pageSentences: facts.map((f) => ({ text: f.text, factIds: [f.id] }))
  };
}

// ---------------------------------------------------------------------------
// Minimal in-memory DOM used only to run web/app.js unmodified for the live layer
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
}

function createAppSession(seedRecord) {
  const seedJson = TawCore.serialize(seedRecord);
  if (seedJson === null) {
    throw new Error("시드 레코드를 직렬화할 수 없다 (계약 위반)");
  }

  const indexHtml = fs.readFileSync(INDEX_PATH, "utf8");
  const ids = [];
  for (const match of indexHtml.matchAll(/\bid="([^"]+)"/g)) ids.push(match[1]);
  const elements = new Map(ids.map((id) => [id, Object.assign(new FakeElement("div"), { id })]));

  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const element = new FakeElement("div");
        element.id = id;
        elements.set(id, element);
      }
      return elements.get(id);
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    }
  };

  const storage = new Map([[TawCore.STORAGE_KEY, seedJson]]);
  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    }
  };

  const requests = [];
  const gateCalls = [];
  // Observe the app's own serving gate without changing its behavior: record the
  // sentence list and allowed-id list the app actually passes to its validator.
  // This is a subject observation only; the PASS/FAIL oracle is still local.
  const appCore = Object.assign({}, TawCore, {
    validateComposition(sentences, allowedIds) {
      const ids = allowedIds && typeof allowedIds[Symbol.iterator] === "function"
        ? Array.from(allowedIds)
        : [];
      gateCalls.push({
        sentences: deepClone(sentences),
        allowedIds: ids
      });
      return TawCore.validateComposition(sentences, allowedIds);
    }
  });
  const appFetch = async (url, options = {}) => {
    const request = {
      url: String(url),
      body: options.body,
      facts: null,
      parseError: null,
      status: null,
      responseSnippet: ""
    };
    try {
      request.facts = extractRequestFacts(options.body);
    } catch (err) {
      request.parseError = err && err.message ? err.message : String(err);
    }
    requests.push(request);

    const headers = Object.assign({}, options.headers || {}, { Origin: ORIGIN });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
    try {
      const response = await fetch(String(url), Object.assign({}, options, {
        headers,
        signal: controller.signal
      }));
      const text = await response.text();
      request.status = response.status;
      request.responseSnippet = text.slice(0, 400);
      return new Response(text, {
        status: response.status,
        headers: { "Content-Type": response.headers.get("content-type") || "application/json" }
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const sandbox = {
    window: { TawCore: appCore, scrollTo() {} },
    document,
    localStorage,
    navigator: {},
    URL: {
      createObjectURL() { return "blob:harness-session"; },
      revokeObjectURL() {}
    },
    fetch: appFetch,
    setTimeout,
    clearTimeout,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_PATH, "utf8"), sandbox, { filename: "web/app.js" });

  function click(id) {
    document.getElementById(id).click();
  }

  function setValue(id, value) {
    document.getElementById(id).value = value;
  }

  function trigger(id, type) {
    document.getElementById(id).trigger(type);
  }

  function currentRaw() {
    const raw = localStorage.getItem(TawCore.STORAGE_KEY);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch (err) {
      return { __parseError: err.message };
    }
  }

  function errorText(id) {
    const element = document.getElementById(id);
    if (!element || element.hidden) return "";
    return element.textContent.trim();
  }

  async function waitFor(predicate, timeoutMs = LIVE_TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await sleep(200);
    }
    return false;
  }

  return {
    click,
    setValue,
    trigger,
    currentRaw,
    errorText,
    waitFor,
    requests,
    gateCalls,
    storage
  };
}

function extractRequestFacts(body) {
  if (typeof body !== "string") throw new Error("요청 본문이 문자열이 아니다");
  const payload = JSON.parse(body);
  if (!payload || !Array.isArray(payload.messages) || !payload.messages[1]) {
    throw new Error("Worker 요청에 messages[1]이 없다");
  }
  const content = payload.messages[1].content;
  if (typeof content !== "string") throw new Error("messages[1].content가 문자열이 아니다");
  const factsJson = content.split("\n\n")[0];
  const facts = JSON.parse(factsJson);
  if (!Array.isArray(facts)) throw new Error("요청 사실 목록이 배열이 아니다");
  return facts.map((f) => ({ id: f.id, text: f.text }));
}

// ---------------------------------------------------------------------------
// Live sessions (real Worker / real model)
// ---------------------------------------------------------------------------

async function runLiveV1Once() {
  const seed = buildFixtureRecord();
  const app = createAppSession(seed);

  app.click("goto-confirmed-btn");
  app.click("open-preview-btn");
  const briefingSettled = await app.waitFor(() => {
    const record = app.currentRaw();
    return (record && Array.isArray(record.briefing) && record.briefing.length > 0) ||
      app.errorText("preview-error") !== "";
  });

  app.click("open-bedtime-btn");
  const pageSettled = await app.waitFor(() => {
    const record = app.currentRaw();
    return (record && Array.isArray(record.pageSentences) && record.pageSentences.length > 0) ||
      app.errorText("bedtime-error") !== "";
  });

  const record = app.currentRaw();
  return {
    seed,
    app,
    briefingSettled,
    pageSettled,
    briefing: record && Array.isArray(record.briefing) ? record.briefing : null,
    page: record && Array.isArray(record.pageSentences) ? record.pageSentences : null,
    previewError: app.errorText("preview-error"),
    bedtimeError: app.errorText("bedtime-error"),
    requests: app.requests
  };
}

async function runLiveV1() {
  let last = null;
  for (let attempt = 1; attempt <= LIVE_ATTEMPTS; attempt += 1) {
    log("    live v1 시도 " + attempt + "/" + LIVE_ATTEMPTS + " — 실제 Worker 호출");
    last = await runLiveV1Once();
    const briefingOk = Array.isArray(last.briefing) && last.briefing.length > 0;
    const pageOk = Array.isArray(last.page) && last.page.length > 0;
    log("      브리핑: " + (briefingOk ? last.briefing.length + "문장" : "없음") +
      ", 페이지: " + (pageOk ? last.page.length + "문장" : "없음") +
      ", 요청 " + last.requests.length + "건");
    if (briefingOk && pageOk && last.previewError === "" && last.bedtimeError === "") {
      return last;
    }
    log("      미완료/오류 — 재시도: " +
      (last.previewError || last.bedtimeError || "출력 없음"));
  }
  return last;
}

async function runLiveV2Once(v2Seed, newFactId) {
  const app = createAppSession(v2Seed);
  app.click("open-bedtime-btn");
  const pageSettled = await app.waitFor(() => {
    const record = app.currentRaw();
    return (record && Array.isArray(record.pageSentences) && record.pageSentences.length > 0) ||
      app.errorText("bedtime-error") !== "";
  });
  const record = app.currentRaw();
  const page = record && Array.isArray(record.pageSentences) ? record.pageSentences : null;
  const citesCorrected = Array.isArray(page) && page.some((s) =>
    s && Array.isArray(s.factIds) && s.factIds.includes(newFactId)
  );
  return {
    app,
    pageSettled,
    page,
    citesCorrected,
    bedtimeError: app.errorText("bedtime-error"),
    requests: app.requests
  };
}

async function runLiveV2(v2Seed, newFactId) {
  let last = null;
  for (let attempt = 1; attempt <= LIVE_ATTEMPTS; attempt += 1) {
    log("    live v2 시도 " + attempt + "/" + LIVE_ATTEMPTS + " — 실제 Worker 호출");
    last = await runLiveV2Once(v2Seed, newFactId);
    const pageOk = Array.isArray(last.page) && last.page.length > 0;
    log("      페이지: " + (pageOk ? last.page.length + "문장" : "없음") +
      ", 정정 사실 인용: " + (last.citesCorrected ? "있음" : "없음") +
      ", 요청 " + last.requests.length + "건");
    if (pageOk && last.citesCorrected && last.bedtimeError === "") {
      return last;
    }
    log("      미완료/오류 — 재시도: " +
      (last.bedtimeError || (pageOk ? "정정 사실 미인용" : "출력 없음")));
  }
  return last;
}

// ---------------------------------------------------------------------------
// Check 1 — citation integrity
// ---------------------------------------------------------------------------

function check1Deterministic() {
  const violations = [];

  // SPEC check 1, deterministic step 1-2/4: fixture pageSentences, judged by the
  // harness-local oracle against the fixture-derived confirmed set.
  const staticViolations = auditSentences(
    "검사 1 정적(exampleState.pageSentences)",
    fixture.exampleState.pageSentences,
    expectedConfirmedSet,
    allFixtureIds
  );
  violations.push(...staticViolations);

  // SPEC check 1, mutant effect: if the app's own gate would accept a sentence that
  // cites rejected F6, then a model answer containing it could be served. The app
  // gate is the SUBJECT; the verdict below is still made by the local oracle above.
  let gateProbe = { accepted: false, detail: "" };
  try {
    const verdict = TawCore.validateComposition(
      [{ text: F6.text, factIds: [F6.id] }],
      expectedConfirmedIds
    );
    gateProbe.accepted = !!(verdict && verdict.ok === true);
    gateProbe.detail = gateProbe.accepted
      ? "앱 게이트가 F6 인용을 허용했다"
      : "앱 게이트가 F6 인용을 거부했다";
  } catch (err) {
    gateProbe.detail = "앱 게이트 호출 실패(관찰 불가): " +
      (err && err.message ? err.message : String(err));
  }
  if (gateProbe.accepted) {
    violations.push({
      where: "검사 1 반사실 게이트 프로브",
      reason: "거절된 F6를 인용한 문장이 앱 게이트를 통과할 수 있다",
      text: F6.text
    });
  }

  return { violations, gateProbe };
}

function check1WithLive(live, deterministic) {
  const violations = deterministic.violations.slice();
  if (!live) {
    violations.push({ where: "검사 1 라이브", reason: "라이브 실행 결과가 없다", text: "" });
    return violations;
  }
  if (live.previewError) {
    violations.push({ where: "검사 1 라이브 브리핑", reason: live.previewError, text: "" });
  }
  if (live.bedtimeError) {
    violations.push({ where: "검사 1 라이브 페이지", reason: live.bedtimeError, text: "" });
  }
  if (!Array.isArray(live.briefing) || live.briefing.length === 0) {
    violations.push({ where: "검사 1 라이브 브리핑", reason: "최종 서빙 브리핑이 없다", text: "" });
  } else {
    violations.push(...auditSentences(
      "검사 1 라이브 브리핑",
      live.briefing,
      expectedConfirmedSet,
      allFixtureIds
    ));
  }
  if (!Array.isArray(live.page) || live.page.length === 0) {
    violations.push({ where: "검사 1 라이브 페이지", reason: "최종 서빙 페이지가 없다", text: "" });
  } else {
    violations.push(...auditSentences(
      "검사 1 라이브 페이지",
      live.page,
      expectedConfirmedSet,
      allFixtureIds
    ));
  }

  // Observe the allowed-id set the app's own gate actually used during live serving.
  // If the app passed the whole candidate pool (or any set containing F6), check 1
  // fails even when this particular model answer happened not to cite F6.
  const gateCalls = live.app && Array.isArray(live.app.gateCalls) ? live.app.gateCalls : [];
  if (gateCalls.length === 0) {
    violations.push({
      where: "검사 1 라이브 게이트",
      reason: "앱이 라이브 합성에서 인용 검증을 호출하지 않았다",
      text: ""
    });
  } else {
    gateCalls.forEach((call, index) => {
      const where = "검사 1 라이브 게이트 " + (index + 1);
      if (!sameIdSet(call.allowedIds, expectedConfirmedIds)) {
        violations.push({
          where,
          reason: "앱 게이트의 허용 ID 집합이 기대 확정 12개와 다르다: " +
            call.allowedIds.join(","),
          text: ""
        });
      }
      if (call.allowedIds.includes("F6")) {
        violations.push({
          where,
          reason: "앱 게이트가 거절된 F6를 허용 기준에 넣었다",
          text: F6.text
        });
      }
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Check 2 — unconfirmed facts have no influence (input capture, not output)
// ---------------------------------------------------------------------------

function check2Deterministic() {
  const violations = [];
  const record = buildFixtureRecord();

  // SPEC check 2 (a): capture synthesis input and compare ids + texts exactly.
  let capture1 = null;
  try {
    capture1 = projection(TawCore.synthesisFacts(record));
  } catch (err) {
    violations.push({
      where: "검사 2 (a) 경계 포착",
      reason: "synthesisFacts 호출 실패: " + (err && err.message ? err.message : String(err)),
      text: ""
    });
  }

  if (capture1) {
    if (!sameFacts(capture1, expectedConfirmedFacts)) {
      violations.push({
        where: "검사 2 (a) 경계 단언",
        reason: "합성 입력이 기대 확정 12개와 정확히 일치하지 않는다. 포착=" +
          capture1.map((f) => f.id).join(","),
        text: ""
      });
    }
    if (capture1.some((f) => f.id === F6.id)) {
      violations.push({
        where: "검사 2 (a) 경계 단언",
        reason: "거절된 F6의 ID가 합성 입력에 들어 있다",
        text: F6.text
      });
    }
    if (capture1.some((f) => f.text === F6.text)) {
      violations.push({
        where: "검사 2 (a) 경계 단언",
        reason: "거절된 F6의 텍스트가 합성 입력에 들어 있다",
        text: F6.text
      });
    }
  }

  // SPEC check 2 (b): add an undecided candidate with a unique marker, capture again.
  const markerId = "__S7_UNDECIDED_MARKER__";
  const markerText = "S7 고유 미결정 마커 — 이 문장은 어떤 합성 입력에도 닿으면 안 된다";
  if (allFixtureIds.has(markerId) || fixtureCandidates.some((c) => c.text === markerText)) {
    violations.push({
      where: "검사 2 (b) 마커",
      reason: "하니스 마커가 픽스처 사실과 겹친다",
      text: markerText
    });
  }
  const marker = {
    id: markerId,
    text: markerText,
    source: "memo",
    grade: "C",
    decision: "undecided"
  };
  const recordWithMarker = Object.assign({}, record, {
    candidates: record.candidates.concat([deepClone(marker)])
  });

  let capture2 = null;
  try {
    capture2 = projection(TawCore.synthesisFacts(recordWithMarker));
  } catch (err) {
    violations.push({
      where: "검사 2 (b) 경계 포착",
      reason: "synthesisFacts 호출 실패: " + (err && err.message ? err.message : String(err)),
      text: ""
    });
  }

  if (capture1 && capture2) {
    if (!sameFacts(capture2, capture1)) {
      violations.push({
        where: "검사 2 (b) 무영향 단언",
        reason: "미결정 후보 추가 후 합성 입력이 달라졌다. 포착=" +
          capture2.map((f) => f.id).join(","),
        text: ""
      });
    }
    if (capture2.some((f) => f.id === markerId || f.text === markerText)) {
      violations.push({
        where: "검사 2 (b) 무영향 단언",
        reason: "미결정 마커 후보가 합성 입력에 들어 있다",
        text: markerText
      });
    }
  }

  return { violations, capture1, capture2, marker };
}

function check2WithLive(live, deterministic) {
  const violations = deterministic.violations.slice();
  if (!live) {
    violations.push({ where: "검사 2 라이브", reason: "라이브 실행 결과가 없다", text: "" });
    return violations;
  }

  // SPEC check 2 live step 1: every outgoing Worker request with the fixture state
  // (confirmed 12, rejected F6) must carry exactly the confirmed 12 facts.
  if (!Array.isArray(live.requests) || live.requests.length === 0) {
    violations.push({ where: "검사 2 라이브 경계", reason: "Worker 요청이 포착되지 않았다", text: "" });
  } else {
    live.requests.forEach((request, index) => {
      const where = "검사 2 라이브 요청 " + (index + 1);
      if (!request.facts) {
        violations.push({
          where,
          reason: "요청에서 사실 목록을 파싱할 수 없다: " + (request.parseError || "알 수 없음"),
          text: ""
        });
        return;
      }
      if (!sameFacts(request.facts, expectedConfirmedFacts)) {
        violations.push({
          where,
          reason: "요청 사실 목록이 기대 확정 12개와 다르다. 포착=" +
            request.facts.map((f) => f.id).join(","),
          text: ""
        });
      }
      if (request.facts.some((f) => f.id === F6.id || f.text === F6.text)) {
        violations.push({
          where,
          reason: "거절된 F6가 Worker 요청에 실렸다",
          text: F6.text
        });
      }
    });
  }

  // SPEC check 2 live step 2: final output must not cite F6 or contain its markers.
  const outputSentences = []
    .concat(Array.isArray(live.briefing) ? live.briefing : [])
    .concat(Array.isArray(live.page) ? live.page : []);
  if (outputSentences.length === 0) {
    violations.push({
      where: "검사 2 라이브 출력",
      reason: "최종 서빙 출력이 없어 금지 내용 부재를 판정할 수 없다",
      text: ""
    });
  }
  outputSentences.forEach((sentence, index) => {
    if (!sentence || typeof sentence !== "object") return;
    if (Array.isArray(sentence.factIds) && sentence.factIds.includes(F6.id)) {
      violations.push({
        where: "검사 2 라이브 출력 " + (index + 1),
        reason: "거절된 F6를 인용했다",
        text: sentence.text || ""
      });
    }
    const text = typeof sentence.text === "string" ? sentence.text : "";
    for (const marker of F6_MARKERS) {
      if (marker.test(text)) {
        violations.push({
          where: "검사 2 라이브 출력 " + (index + 1),
          reason: "F6 내용 마커가 출력에 나타났다: " + marker.name,
          text
        });
      }
    }
  });

  if (live.previewError || live.bedtimeError) {
    violations.push({
      where: "검사 2 라이브",
      reason: live.previewError || live.bedtimeError,
      text: ""
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Check 3 — correction/version integrity
// ---------------------------------------------------------------------------

// Drive the real app UI invalidation path: edit the memo input and fire the
// same `input` event the browser would. The app must route this through
// TawCore.invalidateExtraction, persist the cleared state, and keep only the
// new memo text. This observes the app as a subject; no app output is used as
// an oracle.
function runUiInvalidationProbe(v1Record, correctedMemo) {
  const app = createAppSession(v1Record);
  app.setValue("memo-input", correctedMemo);
  app.trigger("memo-input", "input");
  return { app, record: app.currentRaw() };
}

function check3Deterministic() {
  const checks = [];
  const violations = [];

  function assert(name, condition, detail) {
    checks.push({ name, ok: !!condition, detail });
    if (!condition) {
      violations.push({ where: "검사 3 " + name, reason: detail, text: "" });
    }
  }

  // 1. v1 snapshot (pre-correction persisted page).
  const v1 = buildFixtureRecord();
  const v1Composed = Object.assign({}, v1, {
    briefing: stubComposition(confirmedFromRecord(v1)).briefing,
    pageSentences: deepClone(fixture.exampleState.pageSentences)
  });
  const v1Bytes = TawCore.serialize(v1Composed);
  if (v1Bytes === null) {
    return {
      checks,
      violations: [{ where: "검사 3 v1", reason: "v1 직렬화 실패", text: "" }],
      log: []
    };
  }
  const v1Snapshot = deepClone(v1Composed);
  const v1SnapshotBytes = v1Bytes;
  const v1Id = sha256Hex(v1Bytes);
  const versionStore = new Map([[v1Id, v1Bytes]]);
  // Interface note: web/core.js has no explicit page-version identifier or history;
  // it persists one record under taw-day-v1. Per the S7 starter packet, the spec's
  // v1/v2 map to pre-correction and post-legal-path persisted snapshots. The harness
  // therefore identifies versions by SHA-256 of the serialized record and keeps both
  // snapshots itself. In-place mutation of the v1 state is still caught by the byte
  // comparisons below; a version number alone is never treated as evidence.
  const v1FactTextById = new Map(v1Composed.candidates.map((c) => [c.id, c.text]));

  // 2. Invalidation on memo edit.
  const correctedMemo = fixture.memo.text.replace("한 달", "두 달");
  assert("정정 메모 도출", correctedMemo !== fixture.memo.text && correctedMemo.includes("두 달"),
    "fixture 메모에서 '한 달'을 '두 달'로 정정할 수 있어야 한다");

  let invalidated = null;
  try {
    invalidated = TawCore.invalidateExtraction(Object.assign({}, v1Composed, {
      memoText: correctedMemo
    }));
  } catch (err) {
    assert("무효화 호출", false, "invalidateExtraction 실패: " +
      (err && err.message ? err.message : String(err)));
  }

  if (invalidated) {
    assert("무효화: 후보·결정 제거", invalidated.candidates.length === 0,
      "수정 후에도 후보가 남아 있다: " + invalidated.candidates.length + "개");
    assert("무효화: 확정 집합 제거", confirmedFromRecord(invalidated).length === 0,
      "수정 후에도 구 확정 집합이 살아 있다");
    assert("무효화: unknowns 제거", invalidated.unknowns.length === 0,
      "수정 후에도 unknowns가 남아 있다");
    assert("무효화: 브리핑 제거", invalidated.briefing === null,
      "수정 후에도 v1 브리핑이 남아 있다");
    assert("무효화: 페이지 제거", Array.isArray(invalidated.pageSentences) &&
      invalidated.pageSentences.length === 0, "수정 후에도 v1 페이지가 남아 있다");
    assert("무효화: gate1 재계산", invalidated.gate1Complete === false,
      "수정 후 gate1Complete가 false가 아니다");
    assert("무효화: 새 메모 유지", invalidated.memoText === correctedMemo,
      "수정된 메모 텍스트가 상태에 반영되지 않았다");
  }

  // 2b. App-level invalidation: drive the real memo input handler. The app must
  //     persist the invalidated state, not just return an invalidated object from
  //     core. This catches an app that forgets to call invalidateExtraction or
  //     persists stale composition after an edit.
  let uiProbe = null;
  try {
    uiProbe = runUiInvalidationProbe(v1Composed, correctedMemo);
  } catch (err) {
    assert("UI 무효화 호출", false, "memo input 이벤트 처리 실패: " +
      (err && err.message ? err.message : String(err)));
  }
  if (uiProbe) {
    const uiRecord = uiProbe.record;
    if (!uiRecord || uiRecord.__parseError) {
      assert("UI 무효화 상태 저장", false, "앱이 저장한 상태를 읽을 수 없다: " +
        (uiRecord && uiRecord.__parseError ? uiRecord.__parseError : "저장 없음"));
    } else {
      assert("UI 무효화: 후보·결정 제거",
        Array.isArray(uiRecord.candidates) && uiRecord.candidates.length === 0,
        "메모 수정 후 앱 상태에 후보가 남아 있다: " +
        (Array.isArray(uiRecord.candidates) ? uiRecord.candidates.length + "개" : "배열 아님"));
      assert("UI 무효화: 확정 집합 제거",
        Array.isArray(uiRecord.candidates) &&
        !uiRecord.candidates.some((c) => c && c.decision === "confirmed"),
        "메모 수정 후 앱 상태에 확정 사실이 남아 있다");
      assert("UI 무효화: unknowns 제거",
        Array.isArray(uiRecord.unknowns) && uiRecord.unknowns.length === 0,
        "메모 수정 후 앱 상태에 unknowns가 남아 있다");
      assert("UI 무효화: 브리핑 제거", uiRecord.briefing === null,
        "메모 수정 후 앱 상태에 v1 브리핑이 남아 있다");
      assert("UI 무효화: 페이지 제거",
        Array.isArray(uiRecord.pageSentences) && uiRecord.pageSentences.length === 0,
        "메모 수정 후 앱 상태에 v1 페이지가 남아 있다");
      assert("UI 무효화: gate1 재계산", uiRecord.gate1Complete === false,
        "메모 수정 후 앱 상태의 gate1Complete가 false가 아니다");
      assert("UI 무효화: 새 메모 유지", uiRecord.memoText === correctedMemo,
        "메모 수정 후 앱 상태의 memoText가 수정 내용이 아니다");
      assert("UI 무효화: v1 시드 불변",
        TawCore.serialize(v1Composed) === v1SnapshotBytes,
        "UI 무효화 경로가 v1 원본 객체를 변경했다");
    }
  }

  // 3. Legal path: re-extract (corrected fact gets a harness-generated new id),
  //    reconfirm, recompose with the recording stub.
  const oldF10Text = F10.text;
  const correctedText = oldF10Text.replace("한 달", "두 달");
  assert("정정 사실 텍스트 도출", correctedText !== oldF10Text && correctedText.includes("두 달"),
    "F10 텍스트에서 '한 달'을 '두 달'로 정정할 수 있어야 한다");

  const newIdCandidate = firstFreeFactId(allFixtureIds);
  const reextractedRaw = fixtureCandidates
    .filter((c) => c.id !== "F10")
    .map((c) => ({ id: c.id, text: c.text, source: c.source, grade: c.grade }));
  reextractedRaw.push({
    id: newIdCandidate,
    text: correctedText,
    source: "memo",
    grade: "C"
  });

  let v2 = invalidated;
  try {
    const token = TawCore.beginExtraction(invalidated);
    v2 = TawCore.applyExtraction(invalidated, token, {
      candidates: reextractedRaw,
      unknowns: deepClone(fixture.unknowns)
    });
  } catch (err) {
    assert("재추출 호출", false, "applyExtraction 실패: " +
      (err && err.message ? err.message : String(err)));
  }

  if (v2) {
    assert("재추출: 후보 존재", v2.candidates.length === 13,
      "재추출 후보 수가 13개가 아니다: " + v2.candidates.length);
    assert("재추출: 새 추출은 undecided", v2.candidates.every((c) => c.decision === "undecided"),
      "재추출 후보가 undecided에서 시작하지 않는다");
  }

  let newFact = null;
  if (v2) {
    const matches = v2.candidates.filter((c) => c.text === correctedText);
    assert("정정 사실 유일", matches.length === 1,
      "정정 텍스트를 가진 후보가 정확히 1개가 아니다: " + matches.length);
    if (matches.length === 1) newFact = matches[0];
  }

  if (v2 && newFact) {
    assert("정정 사실 새 ID", newFact.id !== "F10", "정정 사실이 구 F10 ID를 그대로 쓴다");
    assert("정정 사실 ID 비충돌", !v1FactTextById.has(newFact.id),
      "정정 사실 ID가 v1의 다른 사실 ID를 재사용한다: " + newFact.id);

    // Reconfirm all non-F6 candidates, re-reject F6 (the parent's original decision
    // remains the legal choice after re-extraction).
    for (const candidate of v2.candidates.slice()) {
      const decision = candidate.id === "F6" ? "rejected" : "confirmed";
      v2 = TawCore.setDecision(v2, candidate.id, decision);
    }
    const v2Facts = confirmedFromRecord(v2);
    assert("v2 확정 집합", sameFacts(v2Facts, expectedConfirmedFacts
      .filter((f) => f.id !== "F10")
      .concat([{ id: newFact.id, text: correctedText }])),
      "v2 확정 집합이 기대 관계와 다르다: " + v2Facts.map((f) => f.id).join(","));

    const composed = stubComposition(v2Facts);
    v2 = Object.assign({}, v2, composed);

    const v2Bytes = TawCore.serialize(v2);
    assert("v2 직렬화", v2Bytes !== null, "v2 직렬화 실패");
    if (v2Bytes !== null) {
      const v2Id = sha256Hex(v2Bytes);
      versionStore.set(v2Id, v2Bytes);
      assert("v1/v2 버전 분리", v2Id !== v1Id, "v2 버전 ID가 v1과 같다");
      assert("두 버전 조회 가능", versionStore.has(v1Id) && versionStore.has(v2Id),
        "버전 저장소에서 v1/v2를 모두 조회할 수 없다");
      assert("현재 버전 = v2", sha256Hex(v2Bytes) === v2Id && v2Id !== v1Id,
        "현재로 서빙되는 버전이 v2가 아니다");

      // 4. v2 assertions.
      const v2Page = v2.pageSentences;
      const related = v2Page.filter((s) => Array.isArray(s.factIds) && s.factIds.includes(newFact.id));
      assert("v2 정정 사실 인용", related.length > 0,
        "v2 페이지에 정정 사실 새 ID를 인용하는 문장이 없다");
      const v2FactById = new Map(v2.candidates.map((c) => [c.id, c]));
      const resolved = v2FactById.has(newFact.id) ? v2FactById.get(newFact.id).text : null;
      assert("v2 정정 텍스트 해소", resolved === correctedText && resolved.includes("두 달"),
        "새 ID를 해소한 텍스트가 정정 내용이 아니다: " + resolved);
      assert("v2 구 F10 ID 부재", !v2.candidates.some((c) => c.id === "F10") &&
        !v2Page.some((s) => Array.isArray(s.factIds) && s.factIds.includes("F10")),
        "v2에 구 F10 ID가 현재 사실로 남아 있다");
      assert("v2 구 F10 텍스트 부재", !v2.candidates.some((c) => c.text === oldF10Text) &&
        !v2Page.some((s) => typeof s.text === "string" && s.text.includes("한 달")) &&
        !v2.briefing.some((s) => typeof s.text === "string" && s.text.includes("한 달")),
        "v2에 구 F10 텍스트('한 달')가 현재 사실로 남아 있다");

      // 5. v1 byte-level immutability, including the original object reference.
      const v1After = TawCore.serialize(v1Composed);
      const snapshotAfter = TawCore.serialize(v1Snapshot);
      assert("v1 원본 참조 불변", v1After === v1SnapshotBytes,
        "정정 후 v1 원본 객체가 바뀌었다");
      assert("v1 스냅샷 바이트 불변", snapshotAfter === v1SnapshotBytes,
        "정정 후 v1 스냅샷 바이트가 바뀌었다");
      assert("v1 저장소 바이트 불변", versionStore.get(v1Id) === v1SnapshotBytes,
        "버전 저장소의 v1 바이트가 바뀌었다");
      assert("v1 스냅샷에 구 F10 보존",
        v1Snapshot.candidates.some((c) => c.id === "F10" && c.text === oldF10Text) &&
        v1Snapshot.pageSentences.length > 0,
        "v1 스냅샷이 구 F10/페이지를 보존하지 않는다");

      // 6. Currentness: current store is v2, not v1.
      const currentBytes = versionStore.get(v2Id);
      const current = JSON.parse(currentBytes);
      assert("현재성: 현재 페이지 = v2",
        JSON.stringify(current.pageSentences) === JSON.stringify(v2Page),
        "현재로 서빙되는 페이지가 v2 데이터가 아니다");
      assert("현재성: 현재 브리핑 = v2",
        JSON.stringify(current.briefing) === JSON.stringify(v2.briefing),
        "현재로 서빙되는 브리핑이 v2 데이터가 아니다");
      assert("현재성: v1 페이지 비서빙",
        JSON.stringify(current.pageSentences) !== JSON.stringify(v1Snapshot.pageSentences),
        "캐시된 v1 페이지가 현재로 서빙된다");
      assert("현재성: 현재 버전 ID = v2", sha256Hex(currentBytes) === v2Id,
        "현재 저장소가 v2 버전 ID를 가리키지 않는다");

      checks.push({
        name: "버전 ID",
        ok: true,
        detail: "v1=" + v1Id.slice(0, 16) + " v2=" + v2Id.slice(0, 16) +
          " newFact=" + newFact.id
      });

      return {
        checks,
        violations,
        v1Id,
        v2Id,
        newFactId: newFact.id,
        correctedText,
        oldF10Text,
        v2Record: v2,
        v2Facts,
        v2Seed: Object.assign({}, deepClone(v2), {
          briefing: null,
          pageSentences: []
        }),
        versionStore,
        allV2Ids: new Set(v2.candidates.map((c) => c.id)),
        v2FactById
      };
    }
  }

  return { checks, violations, versionStore, v1Id, v1SnapshotBytes };
}

function check3WithLive(live, deterministic) {
  const violations = deterministic.violations.slice();
  if (!deterministic.newFactId) {
    violations.push({
      where: "검사 3 라이브",
      reason: "결정론 층에서 정정 사실 ID가 확정되지 않아 라이브 검사를 진행할 수 없다",
      text: ""
    });
    return violations;
  }
  if (!live) {
    violations.push({ where: "검사 3 라이브", reason: "라이브 실행 결과가 없다", text: "" });
    return violations;
  }
  if (live.bedtimeError) {
    violations.push({ where: "검사 3 라이브 페이지", reason: live.bedtimeError, text: "" });
  }
  if (!Array.isArray(live.page) || live.page.length === 0) {
    violations.push({ where: "검사 3 라이브 페이지", reason: "최종 서빙 v2 페이지가 없다", text: "" });
    return violations;
  }

  // SPEC check 3 live step 2: apply the check 1 independent oracle to v2 output.
  violations.push(...auditSentences(
    "검사 3 라이브 페이지",
    live.page,
    new Set(deterministic.v2Facts.map((f) => f.id)),
    deterministic.allV2Ids
  ));

  // SPEC check 3 live step 1: outgoing request must carry the v2 confirmed set,
  // never old F10 and never rejected F6.
  if (!Array.isArray(live.requests) || live.requests.length === 0) {
    violations.push({ where: "검사 3 라이브 경계", reason: "Worker 요청이 포착되지 않았다", text: "" });
  } else {
    live.requests.forEach((request, index) => {
      const where = "검사 3 라이브 요청 " + (index + 1);
      if (!request.facts) {
        violations.push({
          where,
          reason: "요청에서 사실 목록을 파싱할 수 없다: " + (request.parseError || "알 수 없음"),
          text: ""
        });
        return;
      }
      if (!sameFacts(request.facts, deterministic.v2Facts)) {
        violations.push({
          where,
          reason: "요청 사실 목록이 v2 확정 집합과 다르다. 포착=" +
            request.facts.map((f) => f.id).join(","),
          text: ""
        });
      }
      if (request.facts.some((f) => f.id === "F10" || f.text === deterministic.oldF10Text)) {
        violations.push({
          where,
          reason: "구 F10이 v2 Worker 요청에 실렸다",
          text: deterministic.oldF10Text
        });
      }
    });
  }

  // SPEC check 3 live step 3: corrected fact must be cited and resolve to correction.
  const cited = live.page.some((sentence) =>
    sentence && Array.isArray(sentence.factIds) && sentence.factIds.includes(deterministic.newFactId)
  );
  if (!cited) {
    violations.push({
      where: "검사 3 라이브 페이지",
      reason: "정정된 사실의 새 ID를 인용하는 문장이 없다: " + deterministic.newFactId,
      text: ""
    });
  }
  const resolved = deterministic.v2FactById.get(deterministic.newFactId);
  if (!resolved || !resolved.text.includes("두 달") || resolved.text.includes("한 달")) {
    violations.push({
      where: "검사 3 라이브 해소",
      reason: "정정된 사실 ID가 '두 달' 텍스트로 해소되지 않는다: " +
        (resolved ? resolved.text : "없음"),
      text: ""
    });
  }
  const stale = live.page.filter((sentence) => {
    const text = sentence && typeof sentence.text === "string" ? sentence.text : "";
    return text.includes("한 달") || text === deterministic.oldF10Text;
  });
  if (stale.length > 0) {
    violations.push({
      where: "검사 3 라이브 페이지",
      reason: "구 F10 텍스트('한 달')가 v2 라이브 출력에 나타났다",
      text: stale[0].text
    });
  }

  const gateCalls = live.app && Array.isArray(live.app.gateCalls) ? live.app.gateCalls : [];
  if (gateCalls.length === 0) {
    violations.push({
      where: "검사 3 라이브 게이트",
      reason: "v2 라이브 합성에서 앱이 인용 검증을 호출하지 않았다",
      text: ""
    });
  } else {
    const v2Ids = deterministic.v2Facts.map((f) => f.id);
    gateCalls.forEach((call, index) => {
      if (!sameIdSet(call.allowedIds, v2Ids)) {
        violations.push({
          where: "검사 3 라이브 게이트 " + (index + 1),
          reason: "앱 게이트의 허용 ID 집합이 v2 확정 집합과 다르다: " +
            call.allowedIds.join(","),
          text: ""
        });
      }
      if (call.allowedIds.includes("F10") || call.allowedIds.includes("F6")) {
        violations.push({
          where: "검사 3 라이브 게이트 " + (index + 1),
          reason: "앱 게이트 허용 집합에 구 F10/거절 F6가 들어 있다",
          text: ""
        });
      }
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("S7 counterfactual harness — spec frozen 2026-10-31");
  log("fixture: fixtures/deuri-day.json  sha256=" + fixtureHashBefore);
  log("expected confirmed (fixture exampleState.confirmed): " + expectedConfirmedIds.join(", "));
  log("expected rejected: " + expectedRejectedIds.join(", "));
  log("F6 markers (derived from fixture F6): " + F6_MARKERS.map((m) => m.name).join(", "));
  log("");

  // Deterministic check 1/2 inputs.
  const det1 = check1Deterministic();
  const det2 = check2Deterministic();

  // Live v1 run is shared by check 1 (final served output) and check 2 (request capture).
  let live1 = null;
  let live1Error = "";
  try {
    live1 = await runLiveV1();
  } catch (err) {
    live1Error = err && err.stack ? err.stack : String(err);
    log("    live v1 실행 오류: " + live1Error);
  }
  const live1ForChecks = live1 || (live1Error ? {
    briefing: null,
    page: null,
    requests: [],
    previewError: "라이브 v1 실행 오류: " + live1Error,
    bedtimeError: "라이브 v1 실행 오류: " + live1Error
  } : null);

  // ---------------- Check 1 report ----------------
  const check1Violations = check1WithLive(live1ForChecks, det1);
  const check1Ok = check1Violations.length === 0;
  log("[검사 1] " + (check1Ok ? "PASS" : "FAIL") + " — 인용 무결성: 모든 문장은 확정 사실만 인용한다");
  log("  결정론 층");
  printSentences("정적 exampleState.pageSentences", fixture.exampleState.pageSentences);
  log("  반사실 게이트 프로브 (앱 validateComposition은 피검 대상, 판정은 하네스 오라클): " +
    det1.gateProbe.detail);
  log("  라이브 층 (실제 Worker/모델, web/app.js 최종 서빙 출력)");
  if (live1ForChecks) {
    printSentences("브리핑", live1ForChecks.briefing);
    printSentences("페이지", live1ForChecks.page);
    const gateCalls = live1ForChecks.app && Array.isArray(live1ForChecks.app.gateCalls)
      ? live1ForChecks.app.gateCalls
      : [];
    gateCalls.forEach((call, index) => {
      log("    앱 게이트 " + (index + 1) + " 허용 ID: [" + call.allowedIds.join(",") + "]");
    });
  } else {
    log("    (라이브 결과 없음)");
  }
  if (!check1Ok) {
    log("  위반 상세:");
    printViolations(check1Violations);
  }
  log("");

  // ---------------- Check 2 report ----------------
  const check2Violations = check2WithLive(live1ForChecks, det2);
  const check2Ok = check2Violations.length === 0;
  log("[검사 2] " + (check2Ok ? "PASS" : "FAIL") +
    " — 미확정 무영향: 거절/미결정 후보는 합성 입력과 출력에 닿지 않는다");
  log("  결정론 층 (출력 검사가 아니라 합성 입력 포착)");
  log("    (a) 포착: " + (det2.capture1 ? det2.capture1.map((f) => f.id).join(", ") : "없음"));
  log("        기대: " + expectedConfirmedFacts.map((f) => f.id).join(", "));
  log("        F6 부재: " + (det2.capture1 && !det2.capture1.some((f) => f.id === "F6") ? "예" : "아니오"));
  log("    (b) 미결정 마커 추가 후 포착: " +
    (det2.capture2 ? det2.capture2.map((f) => f.id).join(", ") : "없음"));
  log("        (a)와 동일: " + (det2.capture1 && det2.capture2 &&
    sameFacts(det2.capture1, det2.capture2) ? "예" : "아니오"));
  log("  라이브 층 (실제 Worker/모델)");
  if (live1ForChecks && Array.isArray(live1ForChecks.requests)) {
    live1ForChecks.requests.forEach((request, index) => {
      const ids = request.facts ? request.facts.map((f) => f.id).join(", ") : "(파싱 실패)";
      log("    요청 " + (index + 1) + ": HTTP " + request.status + " facts=[" + ids + "]");
    });
  } else {
    log("    (요청 포착 없음)");
  }
  const liveMarkerHits = [];
  const liveOutput = []
    .concat(live1ForChecks && Array.isArray(live1ForChecks.briefing) ? live1ForChecks.briefing : [])
    .concat(live1ForChecks && Array.isArray(live1ForChecks.page) ? live1ForChecks.page : []);
  liveOutput.forEach((sentence) => {
    const text = sentence && typeof sentence.text === "string" ? sentence.text : "";
    for (const marker of F6_MARKERS) {
      if (marker.test(text)) liveMarkerHits.push({ marker: marker.name, text });
    }
  });
  log("    최종 출력 F6 인용: " + liveOutput.filter((s) =>
    s && Array.isArray(s.factIds) && s.factIds.includes("F6")).length + "건");
  log("    최종 출력 F6 마커: " + liveMarkerHits.length + "건" +
    (liveMarkerHits.length > 0 ? " (" + liveMarkerHits.map((h) => h.marker).join(", ") + ")" : ""));
  if (!check2Ok) {
    log("  위반 상세:");
    printViolations(check2Violations);
  }
  log("");

  // ---------------- Check 3 report ----------------
  const det3 = check3Deterministic();
  let live2 = null;
  let live2Error = "";
  if (det3.newFactId && det3.v2Seed) {
    try {
      live2 = await runLiveV2(det3.v2Seed, det3.newFactId);
    } catch (err) {
      live2Error = err && err.stack ? err.stack : String(err);
      log("    live v2 실행 오류: " + live2Error);
    }
  }
  const live2ForChecks = live2 || (live2Error || det3.newFactId ? {
    page: null,
    requests: [],
    bedtimeError: "라이브 v2 실행 오류: " + (live2Error || "실행되지 않음")
  } : null);
  const check3Violations = check3WithLive(live2ForChecks, det3);
  const check3Ok = check3Violations.length === 0;
  log("[검사 3] " + (check3Ok ? "PASS" : "FAIL") +
    " — 정정의 버전 무결성: 새 버전을 만들고 이전 버전을 덮어쓰지 않는다");
  log("  결정론 층");
  for (const check of det3.checks) {
    log("    " + (check.ok ? "ok  " : "FAIL") + " " + check.name +
      (!check.ok && check.detail ? " — " + check.detail : ""));
  }
  log("    v1=" + (det3.v1Id ? det3.v1Id.slice(0, 16) : "?") +
    "  v2=" + (det3.v2Id ? det3.v2Id.slice(0, 16) : "?") +
    "  correctedFact=" + (det3.newFactId || "?"));
  log("  라이브 층 (실제 Worker/모델, v2 재합성)");
  if (live2ForChecks) {
    if (Array.isArray(live2ForChecks.requests)) {
      live2ForChecks.requests.forEach((request, index) => {
        const ids = request.facts ? request.facts.map((f) => f.id).join(", ") : "(파싱 실패)";
        log("    요청 " + (index + 1) + ": HTTP " + request.status + " facts=[" + ids + "]");
      });
    }
    const gateCalls = live2ForChecks.app && Array.isArray(live2ForChecks.app.gateCalls)
      ? live2ForChecks.app.gateCalls
      : [];
    gateCalls.forEach((call, index) => {
      log("    앱 게이트 " + (index + 1) + " 허용 ID: [" + call.allowedIds.join(",") + "]");
    });
    printSentences("v2 페이지", live2ForChecks.page);
  } else {
    log("    (라이브 결과 없음)");
  }
  if (!check3Ok) {
    log("  위반 상세:");
    printViolations(check3Violations);
  }
  log("");

  // ---------------- Core regression ----------------
  const coreRun = spawnSync(process.execPath, [CORE_TEST_PATH], {
    cwd: ROOT,
    encoding: "utf8"
  });
  const coreOut = (coreRun.stdout || "") + (coreRun.stderr || "");
  const coreMatch = coreOut.match(/(\d+) passed, (\d+) failed/);
  const corePassed = coreMatch ? Number(coreMatch[1]) : -1;
  const coreFailed = coreMatch ? Number(coreMatch[2]) : -1;
  const coreOk = coreRun.status === 0 && corePassed === 44 && coreFailed === 0; // S7-fix: 기존 38 + A2/A3 회귀 6
  log("[회귀] " + (coreOk ? "PASS" : "FAIL") + " — core 테스트 44개");
  log("  " + (coreMatch ? coreMatch[0] : "결과 파싱 실패") +
    " (exit " + coreRun.status + ")");
  if (!coreOk) {
    log("  --- core test output ---");
    log(coreOut.trim());
  }
  log("");

  // ---------------- Fixture integrity ----------------
  const fixtureHashAfter = sha256Hex(fs.readFileSync(FIXTURE_PATH));
  const fixtureOk = fixtureHashAfter === fixtureHashBefore;
  log("[무결성] " + (fixtureOk ? "PASS" : "FAIL") +
    " — fixtures/deuri-day.json 무변경");
  log("  before=" + fixtureHashBefore);
  log("  after =" + fixtureHashAfter);
  log("");

  const allOk = check1Ok && check2Ok && check3Ok && coreOk && fixtureOk;
  log("RESULT: " + (allOk ? "PASS" : "FAIL") +
    " — 검사 " + [check1Ok, check2Ok, check3Ok].filter(Boolean).length + "/3 PASS" +
    ", core " + (coreOk ? "44/44" : "FAIL") +
    ", fixture " + (fixtureOk ? "unchanged" : "CHANGED") +
    ", live layer " + (live1 && live2 ? "included" : "incomplete"));
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[S7] harness crashed: " + (err && err.stack ? err.stack : err));
  process.exit(1);
});
