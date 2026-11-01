// S7 — Counterfactual harness v2 (Astra review fixes, 2026-11-01)
//
// One command: node tests/harness.mjs
//
// Scope (tests/ only; app code is never modified):
//   - Check 1: citation integrity. Every served sentence is judged by a local
//     oracle. The app's own validator is a subject, never the oracle.
//   - Check 2: the synthesis boundary. The facts block and the FULL request body
//     of every synthesis attempt are judged: rejected/undecided IDs and texts,
//     F6 markers, non-confirmed candidate text, allowed message/field shape,
//     and correction feedback limited to violation kind + sentence position.
//   - Check 3: correction integrity through the real app correction path. The
//     extraction response deliberately reuses old F10; the app must remap or
//     reject it. Only app-observable properties are asserted: invalidation chain
//     (core + UI handlers), stale composition not served on re-entry (entry
//     guards), and the final ID resolving to the corrected text in the current
//     record. There is no versionStore and no hash-version theater.
//   - H2: the harness collects the sentences the app actually writes into its
//     render containers and asserts storage <-> render equality. Real-browser
//     rendering differences are out of scope here (S13 device playback + S6 E2E).
//   - H4: v2 sentences citing the corrected fact are scanned for old-value tokens
//     ("한 달", "1개월"). This is a token-level guard, not a semantic check.
//   - H5: every marker/forbidden-text scan normalizes to NFC first. An NFD bypass
//     regression probe must be caught.
//   - H6: every attempt/session request, output and violation is accumulated. A
//     later success never erases an earlier violation. Live retries reuse the same
//     storage session; the correction and v2 re-entry share one storage map.
//
// Independence rules:
//   - Expectations come only from fixtures/deuri-day.json and the frozen spec.
//   - No golden file captured from app output is read or written.
//   - The fixture is read-only; every state change is an in-memory copy.
//   - TawCore.validateComposition is observed as a subject where noted; it is
//     never the PASS/FAIL oracle.
//
// Interface limitation, reported by check 3:
//   web/core.js has no explicit page-version identifier or version history. The
//   app persists one current record under taw-day-v1. Therefore "two versions
//   simultaneously queryable" and "v1 bytes preserved" are NOT asserted here;
//   they are not app-observable interfaces. Harness hashes, if printed, are
//   labeled "하니스 장부" and are never treated as app version IDs.

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
const LIVE_SESSION_RETRIES = 2;
const RENDER_WAIT_MS = 15_000;

const fixtureBytes = fs.readFileSync(FIXTURE_PATH);
const fixtureHashBefore = sha256Hex(fixtureBytes);
const fixture = JSON.parse(fixtureBytes.toString("utf8"));

// ---------------------------------------------------------------------------
// Fixture-derived expectations (the only allowed source of expectations)
// ---------------------------------------------------------------------------

const fixtureCandidates = fixture.candidates;
const factById = new Map(fixtureCandidates.map((c) => [c.id, c]));
const allFixtureIds = new Set(fixtureCandidates.map((c) => c.id));
const expectedConfirmedIds = fixture.exampleState.confirmed.slice();
const expectedRejectedIds = fixture.exampleState.rejected.slice();

const F6 = factById.get("F6");
const F10 = factById.get("F10");
if (!F6 || !F10) fatal("fixture가 F6/F10을 포함하지 않는다 — 기준 픽스처가 아니다.");
if (expectedConfirmedIds.length !== 12) {
  fatal("exampleState.confirmed가 12개가 아니다: " + expectedConfirmedIds.length);
}
if (expectedConfirmedIds.includes("F6")) fatal("exampleState.confirmed에 거절된 F6가 들어 있다.");
if (!expectedRejectedIds.includes("F6")) fatal("exampleState.rejected에 F6가 없다.");
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
  { name: "코와 입", test: (text) => /코\s*(?:와|과|\/)\s*입/.test(text) },
  { name: "닿아 있음(접촉)", test: (text) => text.includes("닿") || text.includes("접촉") }
];

// H4 old-value tokens. "한 달" comes from the fixture F10 text. "1개월" is the
// semantic-equivalent token named by the fix packet; both are matched literally.
const OLD_VALUE_TOKENS = [
  { token: "한 달", source: "fixture F10 text" },
  { token: "1개월", source: "fix packet H4" }
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

// H5: every text compare/marker scan goes through NFC first.
function nfc(value) {
  return String(value === null || value === undefined ? "" : value).normalize("NFC");
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
  if (!record || !Array.isArray(record.candidates)) return [];
  return record.candidates
    .filter((c) => c && c.decision === "confirmed")
    .map((c) => ({ id: c.id, text: c.text }));
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

function stripCodeFence(text) {
  let t = String(text).trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z]*\r?\n?/, "").replace(/```\s*$/, "").trim();
  }
  return t;
}

function isFilledString(value) {
  return typeof value === "string" && value.trim() !== "";
}

// ---------------------------------------------------------------------------
// Harness ledger (H6): append-only. A later success never removes an entry.
// ---------------------------------------------------------------------------

const ledger = {
  sessions: [],
  requests: [],
  outputs: [],
  incidents: [],
  violations: { 1: [], 2: [], 3: [] },
  notes: [],
  fixtureHashBefore,
  fixtureHashAfter: null
};

function addSession(session) {
  ledger.sessions.push(session);
  return session;
}

function addViolation(check, violation, context) {
  const entry = Object.assign({
    check,
    where: violation.where || "?",
    reason: violation.reason || "?",
    text: violation.text || "",
    session: context && context.session ? context.session : "",
    attempt: context && context.attempt !== undefined ? context.attempt : null,
    at: new Date().toISOString()
  }, violation);
  entry.check = check;
  ledger.violations[check].push(entry);
  return entry;
}

function addIncident(message, context) {
  ledger.incidents.push(Object.assign({ message, at: new Date().toISOString() }, context || {}));
}

function addNote(message) {
  ledger.notes.push(message);
}

function violationsFor(check) {
  return ledger.violations[check].slice();
}

function realSessions() {
  return ledger.sessions.filter((s) => s.auditOutputs === true);
}

// ---------------------------------------------------------------------------
// Local citation oracle (independent of web/core.js validateComposition)
// ---------------------------------------------------------------------------

function auditSentences(label, sentences, allowedIds, existingIds) {
  const violations = [];
  if (!Array.isArray(sentences)) {
    violations.push({ where: label, reason: "문장 배열이 아니다", text: "" });
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
      violations.push({ where, reason: "factIds에 문자열이 아닌 ID가 있다", text: sentence.text });
      return;
    }
    const nonexistent = sentence.factIds.filter((id) => !existingIds.has(id));
    if (nonexistent.length > 0) {
      violations.push({
        where,
        reason: "픽스처/현재 후보에 없는 ID를 인용했다: " + nonexistent.join(", "),
        text: sentence.text
      });
    }
    const notConfirmed = sentence.factIds.filter((id) => !allowedIds.has(id));
    if (notConfirmed.length > 0) {
      violations.push({
        where,
        reason: "확정 집합 밖의 ID를 인용했다: " + notConfirmed.join(", "),
        text: sentence.text
      });
    }
  });
  return violations;
}

function sentenceList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((s) => ({
    text: s && typeof s.text === "string" ? s.text : "",
    factIds: s && Array.isArray(s.factIds) ? s.factIds.slice() : []
  }));
}

function sameSentenceList(a, b) {
  const left = sentenceList(a).map((s) => ({ text: nfc(s.text), factIds: s.factIds }));
  const right = sentenceList(b).map((s) => ({ text: nfc(s.text), factIds: s.factIds }));
  return JSON.stringify(left) === JSON.stringify(right);
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
// H5 scanners: NFC first, then match
// ---------------------------------------------------------------------------

function markerHits(text) {
  const normalized = nfc(text);
  return F6_MARKERS.filter((marker) => marker.test(normalized)).map((m) => m.name);
}

function containsIdToken(text, id) {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(^|[^A-Za-z0-9_])" + escaped + "([^A-Za-z0-9_]|$)");
  return re.test(nfc(text));
}

function scanForbiddenContent(label, text, context, violations) {
  const body = nfc(text);
  const expectedFacts = context.expectedFacts || [];
  const expectedIds = new Set(expectedFacts.map((f) => f.id));
  const expectedText = expectedFacts.map((f) => nfc(f.text)).join("\n");
  const forbiddenFacts = context.forbiddenFacts || [];
  const nonConfirmedTexts = context.nonConfirmedTexts || [];

  for (const fact of forbiddenFacts) {
    if (!fact || !isFilledString(fact.id)) continue;
    if (!expectedIds.has(fact.id) && containsIdToken(body, fact.id)) {
      violations.push({
        where: label,
        reason: fact.label + " ID가 요청 본문에 나타났다: " + fact.id,
        text: fact.text || ""
      });
    }
    const factText = nfc(fact.text || "");
    if (factText && body.includes(factText)) {
      violations.push({
        where: label,
        reason: fact.label + " 전문이 요청 본문에 나타났다: " + fact.id,
        text: fact.text || ""
      });
    }
  }

  for (const candidateText of nonConfirmedTexts) {
    const normalized = nfc(candidateText);
    if (normalized === "" || expectedText.includes(normalized)) continue;
    if (body.includes(normalized)) {
      violations.push({
        where: label,
        reason: "확정 집합 밖 후보 전문이 요청 본문에 나타났다",
        text: candidateText
      });
    }
  }

  for (const marker of F6_MARKERS) {
    if (marker.test(body)) {
      violations.push({
        where: label,
        reason: "F6 내용 마커가 요청 본문에 나타났다: " + marker.name,
        text: ""
      });
    }
  }
}

function scanOldValueTokens(label, sentences, correctedFactId, violations) {
  for (const sentence of sentenceList(sentences)) {
    if (!sentence.factIds.includes(correctedFactId)) continue;
    const text = nfc(sentence.text);
    for (const token of OLD_VALUE_TOKENS) {
      if (text.includes(nfc(token.token))) {
        violations.push({
          where: label,
          reason: "정정 사실을 인용한 문장에 구 값 토큰이 있다: \"" + token.token +
            "\" (" + token.source + ", 토큰 수준 가드 — 의미 검사 아님)",
          text: sentence.text
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// H1: full synthesis request-body auditor
// ---------------------------------------------------------------------------

function findJsonArrayEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractFactsBlock(userContent) {
  const text = String(userContent);
  const start = text.indexOf("[");
  if (start !== 0) throw new Error("사실 블록이 user 메시지의 첫 JSON 배열이 아니다");
  const end = findJsonArrayEnd(text, start);
  if (end === -1) throw new Error("사실 블록 JSON 배열이 닫히지 않았다");
  const jsonText = text.slice(0, end + 1);
  const rest = text.slice(end + 1);
  const facts = JSON.parse(jsonText);
  if (!Array.isArray(facts)) throw new Error("사실 블록이 배열이 아니다");
  return { facts, rest };
}

function classifyPayload(payload) {
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length < 2) return "unknown";
  const user = payload.messages[1] && payload.messages[1].content;
  if (Array.isArray(user)) {
    if (user.some((part) => part && part.type === "image_url")) return "extraction";
    return "unknown";
  }
  const system = payload.messages[0] && typeof payload.messages[0].content === "string"
    ? payload.messages[0].content
    : "";
  if (system.includes("브리핑")) return "briefing";
  if (system.includes("그림책")) return "page";
  return "unknown";
}

function validateSynthesisStructure(payload) {
  const violations = [];
  const allowedTop = new Set(["model", "reasoning_effort", "messages"]);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    violations.push({ where: "요청 구조", reason: "요청 본문이 객체가 아니다" });
    return violations;
  }
  for (const key of Object.keys(payload)) {
    if (!allowedTop.has(key)) {
      violations.push({ where: "요청 구조", reason: "허용되지 않은 최상위 필드가 있다: " + key });
    }
  }
  if (!isFilledString(payload.model)) {
    violations.push({ where: "요청 구조", reason: "model이 비어 있거나 문자열이 아니다" });
  }
  if (!isFilledString(payload.reasoning_effort)) {
    violations.push({ where: "요청 구조", reason: "reasoning_effort가 비어 있거나 문자열이 아니다" });
  }
  if (!Array.isArray(payload.messages) || payload.messages.length !== 2) {
    violations.push({ where: "요청 구조", reason: "messages가 정확히 2개(system, user)가 아니다" });
    return violations;
  }
  const [system, user] = payload.messages;
  if (!system || typeof system !== "object" || system.role !== "system" ||
      typeof system.content !== "string" || system.content === "") {
    violations.push({ where: "요청 구조", reason: "messages[0]이 비어 있지 않은 system 문자열이 아니다" });
  }
  if (!user || typeof user !== "object" || user.role !== "user" || typeof user.content !== "string") {
    violations.push({ where: "요청 구조", reason: "messages[1]이 문자열 user 메시지가 아니다" });
  }
  return violations;
}

function isAllowedFeedbackReason(reason) {
  const r = nfc(reason).trim();
  if (r.length === 0 || r.length > 48) return false;
  // Violation kind only: no sentence position inside the reason, no IDs, no
  // parentheses that could smuggle a sentence, no quote/digit/punctuation.
  if (/[0-9()[\]{}"'`:;]/.test(r)) return false;
  const patterns = [
    /확정되지 않은 사실/,
    /인용/,
    /근거 없는/,
    /원문에 없는 표현/,
    /형식이 깨진/,
    /문장 배열이 아니/
  ];
  return patterns.some((re) => re.test(r));
}

function validateFeedback(feedback, label, violations) {
  if (feedback === "") return;
  const normalized = nfc(feedback);
  const prefixMatch = normalized.match(/^\n\n이전 답안은 아래 이유로 기각됐다[^\n]*\n/);
  if (!prefixMatch) {
    violations.push({
      where: label,
      reason: "교정 피드백이 허용된 경계 형식으로 시작하지 않는다",
      text: normalized.slice(0, 160)
    });
    return;
  }
  const body = normalized.slice(prefixMatch[0].length);
  if (body.trim() === "") {
    violations.push({ where: label, reason: "교정 피드백 본문이 비어 있다" });
    return;
  }
  // A generic JSON-parse correction is allowed only without raw model output.
  if (/^이전 답안은 깨진 JSON이었다/.test(body.trim())) {
    if (body.includes("(") || body.includes("원문 일부")) {
      violations.push({
        where: label,
        reason: "깨진 JSON 교정 피드백에 모델 원문 스니펫이 실렸다",
        text: body.slice(0, 160)
      });
    }
    return;
  }
  const lines = body.split("\n");
  for (const line of lines) {
    if (line.trim() === "") continue;
    const match = line.match(/^- 문장 (\d+): (.+)$/);
    if (!match) {
      violations.push({
        where: label,
        reason: "교정 피드백 줄이 '문장 위치: 위반 종류' 형식이 아니다",
        text: line
      });
      continue;
    }
    const position = Number(match[1]);
    if (!Number.isInteger(position) || position < 0 || position > 100) {
      violations.push({ where: label, reason: "교정 피드백의 문장 위치가 범위를 벗어났다", text: line });
    }
    if (!isAllowedFeedbackReason(match[2])) {
      violations.push({
        where: label,
        reason: "교정 피드백에 위반 종류 외의 내용이 있다(문장 전문/ID/구체 어휘 의심)",
        text: line
      });
    }
  }
}

function auditSynthesisRequest(body, context) {
  const label = context.label || "합성 요청";
  const violations = [];
  if (typeof body !== "string") {
    return {
      violations: [{ where: label, reason: "요청 본문이 문자열이 아니다", text: "" }],
      facts: null,
      feedback: "",
      kind: "unknown"
    };
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    return {
      violations: [{ where: label, reason: "요청 본문이 JSON이 아니다: " + err.message, text: "" }],
      facts: null,
      feedback: "",
      kind: "unknown"
    };
  }

  const kind = classifyPayload(payload);
  violations.push(...validateSynthesisStructure(payload));

  let facts = null;
  let feedback = "";
  if (Array.isArray(payload.messages) && payload.messages[1] &&
      typeof payload.messages[1].content === "string") {
    try {
      const block = extractFactsBlock(payload.messages[1].content);
      facts = block.facts;
      feedback = block.rest;
    } catch (err) {
      violations.push({ where: label, reason: "사실 블록을 파싱할 수 없다: " + err.message, text: "" });
    }
  }

  if (facts) {
    const factShapeOk = facts.every((fact) => {
      if (!fact || typeof fact !== "object" || Array.isArray(fact)) return false;
      const keys = Object.keys(fact).sort().join(",");
      return keys === "id,text" && isFilledString(fact.id) && typeof fact.text === "string";
    });
    if (!factShapeOk) {
      violations.push({ where: label, reason: "사실 블록 항목의 필드 구조가 {id,text}가 아니다" });
    }
    const ids = facts.map((f) => f.id);
    if (new Set(ids).size !== ids.length) {
      violations.push({ where: label, reason: "사실 블록에 중복 ID가 있다" });
    }
    if (!sameFacts(facts, context.expectedFacts || [])) {
      violations.push({
        where: label,
        reason: "사실 블록이 기대 확정 집합과 정확히 일치하지 않는다. 포착=" +
          (facts.length > 0 ? facts.map((f) => f.id).join(",") : "(없음)"),
        text: ""
      });
    }
  }

  // Full serialized body, NFC-normalized, scanned for rejected/undecided/stale
  // facts, non-confirmed candidate text and F6 markers.
  scanForbiddenContent(label, body, context, violations);

  validateFeedback(feedback, label, violations);

  // A1 boundary: no sentence text or raw model snippet from an earlier attempt
  // may be replayed inside a retry payload. Fact text that is legitimately part
  // of the facts block is excluded.
  const normalizedBody = nfc(body);
  const expectedBlock = (context.expectedFacts || []).map((f) => nfc(f.text)).join("\n");
  for (const priorText of context.priorTexts || []) {
    const normalized = nfc(priorText);
    if (normalized.length < 4) continue;
    if (expectedBlock.includes(normalized)) continue;
    if (normalizedBody.includes(normalized)) {
      violations.push({
        where: label,
        reason: "이전 시도의 문장 전문이 재시도 요청에 실렸다",
        text: priorText
      });
    }
  }
  for (const snippet of context.priorSnippets || []) {
    const normalized = nfc(snippet);
    if (normalized.length < 8) continue;
    if (normalizedBody.includes(normalized)) {
      violations.push({
        where: label,
        reason: "이전 시도의 모델 원문 스니펫이 재시도 요청에 실렸다",
        text: snippet
      });
    }
  }

  return { violations, facts, feedback, kind };
}

// H1 scanner self-test: a good body must pass, every poisoned body must be
// caught. This also proves the NFD probe is normalized before marker scans.
function selfTestH1Scanner() {
  const cases = [];
  const markerText = "__S7_UNDECIDED_SELF_TEST__";
  const markerFact = {
    id: "F_UNDECIDED_SELFTEST",
    text: "S7 미결정 자기검증 마커 문장",
    source: "memo",
    grade: "C"
  };
  const context = {
    label: "H1 자기검증",
    expectedFacts: expectedConfirmedFacts,
    forbiddenFacts: [
      { id: F6.id, text: F6.text, label: "거절된 F6" },
      { id: markerFact.id, text: markerFact.text, label: "미결정 마커" }
    ],
    nonConfirmedTexts: [F6.text, markerFact.text],
    priorTexts: ["오늘은 조용히 산책을 했다"],
    priorSnippets: ["```json { this is not json"],
    existingIds: allFixtureIds
  };

  function makeBody(facts, feedback) {
    return JSON.stringify({
      model: "muse-spark-1.3",
      reasoning_effort: "low",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: JSON.stringify(facts) + feedback }
      ]
    });
  }
  function feedback(line) {
    return "\n\n이전 답안은 아래 이유로 기각됐다 — 이번에는 규칙을 지켜라:\n" + line;
  }
  function runCase(name, body, shouldBeCaught) {
    const result = auditSynthesisRequest(body, context);
    const caught = result.violations.length > 0;
    cases.push({
      name,
      ok: shouldBeCaught ? caught : !caught,
      shouldBeCaught,
      violations: result.violations
    });
  }

  runCase("정상 요청(사실 블록만)", makeBody(expectedConfirmedFacts, ""), false);
  runCase("정상 교정 피드백(종류+위치)",
    makeBody(expectedConfirmedFacts, feedback("- 문장 2: 확정되지 않은 사실 인용")), false);
  runCase("일반 JSON 파싱 실패 피드백(원문 없음)",
    makeBody(expectedConfirmedFacts, feedback("이전 답안은 깨진 JSON이었다. 설명 없이 JSON만 출력하라.")), false);
  runCase("사실 블록 불일치(F10 누락)",
    makeBody(expectedConfirmedFacts.filter((f) => f.id !== "F10"), ""), true);
  runCase("허용되지 않은 최상위 필드",
    JSON.stringify({
      model: "muse-spark-1.3",
      reasoning_effort: "low",
      temperature: 0.2,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: JSON.stringify(expectedConfirmedFacts) }
      ]
    }), true);
  runCase("교정 피드백에 문장 전문",
    makeBody(expectedConfirmedFacts, feedback("- 문장 2 (강아지의 코/입 부위가 아이의 무릎 근처에 닿아 있다): 확정되지 않은 사실 인용")), true);
  runCase("교정 피드백에 거절된 ID",
    makeBody(expectedConfirmedFacts, feedback("- 문장 2: 확정되지 않은 사실 인용 F6")), true);
  runCase("교정 피드백에 거절된 전문",
    makeBody(expectedConfirmedFacts, feedback("- 문장 2: " + F6.text)), true);
  runCase("교정 피드백에 거절된 전문(NFD)",
    makeBody(expectedConfirmedFacts, feedback("- 문장 2: " + F6.text.normalize("NFD"))), true);
  runCase("교정 피드백에 미결정 마커",
    makeBody(expectedConfirmedFacts, feedback("- 문장 2: " + markerFact.text)), true);
  runCase("교정 피드백에 이전 시도 문장",
    makeBody(expectedConfirmedFacts, feedback("- 문장 2: 오늘은 조용히 산책을 했다")), true);
  runCase("교정 피드백에 이전 모델 원문",
    makeBody(expectedConfirmedFacts, feedback("- 문장 2: ```json { this is not json")), true);
  runCase("교정 피드백에 구체 ID가 붙은 위반 사유",
    makeBody(expectedConfirmedFacts, feedback("- 문장 2: 확정되지 않은 사실을 인용했다: F7")), true);

  // Direct H5 NFD probe: the forbidden-content scanner itself must catch NFD.
  const nfdViolations = [];
  scanForbiddenContent("H5 NFD 프로브", F6.text.normalize("NFD"), context, nfdViolations);
  const nfdMarkerHits = markerHits(F6.text.normalize("NFD"));
  const nfdCaught = nfdViolations.length > 0 && nfdMarkerHits.length > 0;
  cases.push({
    name: "NFD 우회 프로브(F6 전문)",
    ok: nfdCaught,
    shouldBeCaught: true,
    violations: nfdCaught ? nfdViolations.slice(0, 1) : []
  });

  // A sentence-level NFD probe for the output marker scanner.
  const nfdSentenceHits = markerHits("강아지의 " + "무릎".normalize("NFD") + " 근처");
  cases.push({
    name: "NFD 우회 프로브(출력 마커)",
    ok: nfdSentenceHits.includes("무릎"),
    shouldBeCaught: true,
    violations: []
  });

  return cases;
}

// ---------------------------------------------------------------------------
// Harness-built states (in-memory only; the fixture is never written)
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
  return {
    briefing: facts.map((f) => ({ text: f.text, factIds: [f.id] })),
    pageSentences: facts.map((f) => ({ text: f.text, factIds: [f.id] }))
  };
}

function composedFixtureRecord() {
  const record = buildFixtureRecord();
  return Object.assign({}, record, stubComposition(confirmedFromRecord(record)));
}

// ---------------------------------------------------------------------------
// Minimal in-memory DOM + app runner (web/app.js runs unmodified via vm)
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
    return "data:image/jpeg;base64,U0VMRlRFU1Q=";
  }
}

function hasClass(element, name) {
  return !!element && String(element.className || "").split(/\s+/).includes(name);
}

function findDescendant(element, predicate) {
  for (const child of element.children || []) {
    if (predicate(child)) return child;
    const nested = findDescendant(child, predicate);
    if (nested) return nested;
  }
  return null;
}

function findDescendants(element, predicate, out = []) {
  for (const child of element.children || []) {
    if (predicate(child)) out.push(child);
    findDescendants(child, predicate, out);
  }
  return out;
}

function collectRendered(elements, containerId, kind) {
  const wrap = elements.get(containerId);
  if (!wrap) return [];
  const lines = (wrap.children || []).filter((child) => hasClass(child, "briefing-line"));
  return lines.map((line) => {
    const textElement = findDescendant(line, (child) => hasClass(child, "candidate-text"));
    const text = textElement ? textElement.textContent : "";
    let factIds = [];
    if (kind === "briefing") {
      factIds = findDescendants(line, (child) => hasClass(child, "chip-fact"))
        .map((chip) => chip.textContent);
    } else {
      factIds = findDescendants(line, (child) => hasClass(child, "provenance"))
        .map((prov) => {
          const match = String(prov.textContent).match(/^원문 \(([^)]+)\):/);
          return match ? match[1] : "";
        })
        .filter((id) => id !== "");
    }
    return { text, factIds };
  });
}

const indexHtml = fs.readFileSync(INDEX_PATH, "utf8");
const INDEX_IDS = Array.from(indexHtml.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]);

function createStorage(seedRecord) {
  const map = new Map();
  if (seedRecord) {
    const json = TawCore.serialize(seedRecord);
    if (json === null) throw new Error("시드 레코드를 직렬화할 수 없다 (계약 위반)");
    map.set(TawCore.STORAGE_KEY, json);
  }
  const localStorage = {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    }
  };
  return { map, localStorage };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function modelResponse(contentObject) {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify(contentObject) } }]
  });
}

async function liveFetchResponse(ctx) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_TIMEOUT_MS);
  try {
    return await fetch(ctx.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN
      },
      body: ctx.body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseModelResponse(info) {
  const output = {
    session: info.session,
    requestIndex: info.requestIndex,
    kind: info.kind,
    status: info.status,
    responseOk: info.responseOk,
    content: "",
    parsed: null,
    parseError: null,
    contractError: null,
    rawSnippet: "",
    sentences: [],
    candidateTexts: []
  };
  if (!info.responseOk) {
    output.parseError = "HTTP " + info.status;
    return output;
  }
  let payload;
  try {
    payload = JSON.parse(info.responseText);
  } catch (err) {
    output.parseError = "응답이 JSON이 아니다: " + err.message;
    output.rawSnippet = info.responseText.slice(0, 160);
    return output;
  }
  const content = payload && payload.choices && payload.choices[0] &&
    payload.choices[0].message ? payload.choices[0].message.content : undefined;
  if (typeof content !== "string") {
    output.parseError = "응답에 choices[0].message.content가 없다";
    output.rawSnippet = info.responseText.slice(0, 160);
    return output;
  }
  output.content = content;
  output.rawSnippet = content.slice(0, 160);
  try {
    output.parsed = JSON.parse(stripCodeFence(content));
  } catch (err) {
    output.parseError = "모델 content가 JSON이 아니다: " + err.message;
    return output;
  }
  const parsed = output.parsed;
  if (info.kind === "briefing") {
    if (!parsed || !Array.isArray(parsed.lines)) {
      output.contractError = "lines가 배열이 아니다";
    } else {
      output.sentences = parsed.lines.map((line) => ({
        text: line && typeof line.text === "string" ? line.text : "",
        factIds: line && Array.isArray(line.factIds)
          ? line.factIds.filter((id) => typeof id === "string")
          : []
      }));
    }
  } else if (info.kind === "page") {
    if (!parsed || !Array.isArray(parsed.sentences)) {
      output.contractError = "sentences가 배열이 아니다";
    } else {
      output.sentences = parsed.sentences.map((sentence) => ({
        text: sentence && typeof sentence.text === "string" ? sentence.text : "",
        factIds: sentence && Array.isArray(sentence.factIds)
          ? sentence.factIds.filter((id) => typeof id === "string")
          : []
      }));
    }
  } else if (info.kind === "extraction") {
    if (!parsed || !Array.isArray(parsed.candidates)) {
      output.contractError = "candidates가 배열이 아니다";
    } else {
      output.candidateTexts = parsed.candidates.map((candidate) =>
        candidate && typeof candidate.text === "string" ? candidate.text : "");
    }
  }
  return output;
}

function createAppSession(options = {}) {
  const storage = options.storage || createStorage();
  if (options.seedRecord) {
    const seedJson = TawCore.serialize(options.seedRecord);
    if (seedJson === null) throw new Error("시드 레코드를 직렬화할 수 없다");
    storage.map.set(TawCore.STORAGE_KEY, seedJson);
  }

  const label = options.label || "app session";
  const session = addSession({
    label,
    meta: options.meta || {},
    live: options.live === true,
    auditOutputs: options.auditOutputs !== false,
    probe: options.probe === true,
    requests: [],
    outputs: [],
    gateCalls: [],
    storage
  });

  const elements = new Map(INDEX_IDS.map((id) => [
    id,
    Object.assign(new FakeElement("div"), { id })
  ]));

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

  const appCore = Object.assign({}, TawCore, {
    validateComposition(sentences, allowedIds) {
      const ids = allowedIds && typeof allowedIds[Symbol.iterator] === "function"
        ? Array.from(allowedIds)
        : [];
      session.gateCalls.push({ sentences: deepClone(sentences), allowedIds: ids });
      return TawCore.validateComposition(sentences, allowedIds);
    }
  });

  const appFetch = async (url, fetchOptions = {}) => {
    const info = {
      session: label,
      requestIndex: session.requests.length,
      url: String(url),
      body: fetchOptions.body,
      payload: null,
      kind: "unknown",
      parseError: null,
      status: null,
      responseOk: false,
      responseText: "",
      error: "",
      startedAt: new Date().toISOString()
    };
    try {
      info.payload = JSON.parse(info.body);
      info.kind = classifyPayload(info.payload);
    } catch (err) {
      info.parseError = err && err.message ? err.message : String(err);
    }
    session.requests.push(info);
    ledger.requests.push(info);

    const ctx = Object.assign({}, info, { session, elements, storage });
    let result = null;
    try {
      if (options.fetchHandler) result = await options.fetchHandler(ctx);
      if (result === undefined || result === null) result = await liveFetchResponse(ctx);
    } catch (err) {
      info.error = err && err.message ? err.message : String(err);
      addIncident("요청 실패: " + info.error, { session: label, requestIndex: info.requestIndex });
      throw err;
    }

    let text = "";
    try {
      text = await result.text();
    } catch (err) {
      info.error = "응답 본문 읽기 실패: " + (err && err.message ? err.message : String(err));
      addIncident(info.error, { session: label, requestIndex: info.requestIndex });
      throw err;
    }
    info.status = result.status;
    info.responseOk = result.ok !== false && result.status >= 200 && result.status < 300;
    info.responseText = text;

    const output = parseModelResponse(info);
    session.outputs.push(output);
    ledger.outputs.push(output);

    return new Response(text, {
      status: result.status,
      headers: {
        "Content-Type": result.headers ? (result.headers.get("content-type") || "application/json")
          : "application/json"
      }
    });
  };

  const sandbox = {
    window: { TawCore: appCore, scrollTo() {} },
    document,
    localStorage: storage.localStorage,
    navigator: {},
    URL: {
      createObjectURL() { return "blob:harness-session"; },
      revokeObjectURL() {}
    },
    fetch: appFetch,
    createImageBitmap: async () => ({ width: 32, height: 24, close() {} }),
    setTimeout,
    clearTimeout,
    // In a browser app.js and core.js share one realm, so a Set created by the
    // app is `instanceof Set` inside core.js (S7-fix A3 burned IDs). A vm
    // sandbox gets its own intrinsics by default; inject the host Set so that
    // cross-file identity matches the real browser instead of manufacturing a
    // false negative in check 3.
    Set,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_PATH, "utf8"), sandbox, { filename: "web/app.js" });

  const api = {
    label,
    session,
    storage,
    click(id) {
      document.getElementById(id).click();
    },
    setValue(id, value) {
      document.getElementById(id).value = value;
    },
    element(id) {
      return document.getElementById(id);
    },
    trigger(id, type) {
      document.getElementById(id).trigger(type);
    },
    currentRaw() {
      const raw = storage.localStorage.getItem(TawCore.STORAGE_KEY);
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch (err) {
        return { __parseError: err.message };
      }
    },
    errorText(id) {
      const element = document.getElementById(id);
      if (!element || element.hidden) return "";
      return element.textContent.trim();
    },
    async waitFor(predicate, timeoutMs = LIVE_TIMEOUT_MS) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate()) return true;
        await sleep(150);
      }
      return false;
    },
    renderedBriefing() {
      return collectRendered(elements, "briefing-lines", "briefing");
    },
    renderedPage() {
      return collectRendered(elements, "page-sentences", "page");
    },
    elements
  };

  return api;
}

// ---------------------------------------------------------------------------
// Deterministic check helpers
// ---------------------------------------------------------------------------

function makeChecks() {
  const checks = [];
  function assert(name, condition, detail) {
    checks.push({ name, ok: !!condition, detail: detail || "" });
  }
  return { checks, assert };
}

function invalidationOk(record, expectedMemo) {
  if (!record || record.__parseError) return false;
  return Array.isArray(record.candidates) && record.candidates.length === 0 &&
    Array.isArray(record.unknowns) && record.unknowns.length === 0 &&
    record.briefing === null &&
    Array.isArray(record.pageSentences) && record.pageSentences.length === 0 &&
    record.gate1Complete === false &&
    record.memoText === expectedMemo;
}

function runInvalidationProbes(v1Composed, correctedMemo) {
  const { checks, assert } = makeChecks();

  // (1) Core invalidation chain.
  let coreInvalidated = null;
  try {
    coreInvalidated = TawCore.invalidateExtraction(Object.assign({}, v1Composed, {
      memoText: correctedMemo
    }));
  } catch (err) {
    assert("core 무효화 호출", false, "invalidateExtraction 실패: " + err.message);
  }
  if (coreInvalidated) {
    assert("core 무효화 연쇄", invalidationOk(coreInvalidated, correctedMemo),
      "core 무효화가 후보·unknowns·브리핑·페이지·gate1을 모두 비우지 않았다");
  }

  // (2) Real memo input handler persists the invalidation.
  try {
    const app = createAppSession({
      seedRecord: v1Composed,
      label: "UI 메모 무효화 프로브",
      auditOutputs: false,
      probe: true
    });
    app.click("edit-memo-btn");
    app.setValue("memo-input", correctedMemo);
    app.trigger("memo-input", "input");
    const record = app.currentRaw();
    assert("UI 메모 무효화 연쇄", invalidationOk(record, correctedMemo),
      record && record.__parseError ? "저장 상태 파싱 실패: " + record.__parseError
        : "메모 input 핸들러가 무효화를 저장하지 않았다");
  } catch (err) {
    assert("UI 메모 무효화 호출", false, "메모 input 처리 실패: " + err.message);
  }

  // (3) Real photo change handler invalidates the same chain.
  try {
    const app = createAppSession({
      seedRecord: v1Composed,
      label: "UI 사진 무효화 프로브",
      auditOutputs: false,
      probe: true
    });
    app.click("edit-memo-btn"); // capture 화면이 memo-input 값을 채운다
    app.element("photo-input").files = [{ name: "invalidation-probe.jpg" }];
    app.trigger("photo-input", "change");
    const record = app.currentRaw();
    assert("UI 사진 무효화 연쇄", invalidationOk(record, v1Composed.memoText),
      record && record.__parseError ? "저장 상태 파싱 실패: " + record.__parseError
        : "사진 change 핸들러가 무효화를 저장하지 않았다");
  } catch (err) {
    assert("UI 사진 무효화 호출", false, "사진 change 처리 실패: " + err.message);
  }

  return { checks };
}

function check2Deterministic() {
  const violations = [];
  const record = buildFixtureRecord();

  let capture1 = null;
  try {
    capture1 = projection(TawCore.synthesisFacts(record));
  } catch (err) {
    violations.push({
      where: "검사 2 (a) 경계 포착",
      reason: "synthesisFacts 호출 실패: " + err.message,
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
    if (capture1.some((f) => f.id === F6.id) ||
        capture1.some((f) => nfc(f.text) === nfc(F6.text))) {
      violations.push({
        where: "검사 2 (a) 경계 단언",
        reason: "거절된 F6가 합성 입력에 들어 있다",
        text: F6.text
      });
    }
  }

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
      reason: "synthesisFacts 호출 실패: " + err.message,
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
    if (capture2.some((f) => f.id === markerId || nfc(f.text) === nfc(markerText))) {
      violations.push({
        where: "검사 2 (b) 무영향 단언",
        reason: "미결정 마커 후보가 합성 입력에 들어 있다",
        text: markerText
      });
    }
  }

  // H1/H5 scanner self-tests. A self-test failure is a harness failure.
  const selfTests = selfTestH1Scanner();
  for (const test of selfTests) {
    if (!test.ok) {
      violations.push({
        where: "H1/H5 스캐너 자기검증 — " + test.name,
        reason: test.shouldBeCaught
          ? "금지 요청을 잡지 못했다"
          : "정상 요청을 오탐했다",
        text: test.violations.length > 0
          ? test.violations.map((v) => v.reason).join(" / ")
          : ""
      });
    }
  }

  return { violations, capture1, capture2, marker, selfTests };
}

// ---------------------------------------------------------------------------
// Settling helpers + live sessions
// ---------------------------------------------------------------------------

function previewSettled(app) {
  const record = app.currentRaw();
  const busy = app.element("preview-synth-status").textContent.includes("만들고 있다");
  const error = app.errorText("preview-error");
  return !busy && ((record && Array.isArray(record.briefing) && record.briefing.length > 0) ||
    error !== "");
}

function pageSettled(app) {
  const record = app.currentRaw();
  const busy = app.element("bedtime-synth-status").textContent.includes("만들고 있다");
  const error = app.errorText("bedtime-error");
  return !busy && ((record && Array.isArray(record.pageSentences) && record.pageSentences.length > 0) ||
    error !== "");
}

async function ensurePreview(app, retries) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await app.waitFor(() => previewSettled(app), LIVE_TIMEOUT_MS);
    const record = app.currentRaw();
    const hasBriefing = record && Array.isArray(record.briefing) && record.briefing.length > 0;
    if (hasBriefing) return true;
    if (attempt < retries) {
      addIncident("브리핑 출력 없음 — 같은 세션에서 재합성", { session: app.label, attempt });
      app.click("resynthesize-btn");
      await sleep(200);
    }
  }
  return false;
}

async function ensurePage(app, retries) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await app.waitFor(() => pageSettled(app), LIVE_TIMEOUT_MS);
    const record = app.currentRaw();
    const hasPage = record && Array.isArray(record.pageSentences) && record.pageSentences.length > 0;
    if (hasPage) return true;
    if (attempt < retries) {
      addIncident("페이지 출력 없음 — 같은 세션에서 재합성", { session: app.label, attempt });
      app.click("recompose-btn");
      await sleep(200);
    }
  }
  return false;
}

async function runLiveV1Session() {
  const seed = buildFixtureRecord();
  const app = createAppSession({
    seedRecord: seed,
    label: "live v1 (검사 1+2)",
    live: true,
    auditOutputs: true,
    meta: {
      role: "v1",
      expectedFacts: expectedConfirmedFacts,
      existingIds: Array.from(allFixtureIds),
      forbiddenFacts: [{ id: F6.id, text: F6.text, label: "거절된 F6" }],
      nonConfirmedTexts: [F6.text]
    }
  });

  app.click("goto-confirmed-btn");
  app.click("open-preview-btn");
  const briefingOk = await ensurePreview(app, LIVE_SESSION_RETRIES);
  app.click("open-bedtime-btn");
  const pageOk = await ensurePage(app, LIVE_SESSION_RETRIES);
  const final = app.currentRaw();

  return {
    app,
    seed,
    final,
    briefingOk,
    pageOk,
    renderedBriefing: app.renderedBriefing(),
    renderedPage: app.renderedPage()
  };
}

// H1 counterfactual: the harness feeds a deliberately violating first answer
// through the real app retry loop, then judges the second request body. The bad
// first answer is intentional and is not counted as an app output violation.
async function runH1RetryProbeSession() {
  const seed = buildFixtureRecord();
  const validBriefing = expectedConfirmedFacts.map((f) => ({ text: f.text, factIds: [f.id] }));
  const validPage = expectedConfirmedFacts.map((f) => ({ text: f.text, factIds: [f.id] }));
  const invalidSentences = [{ text: F6.text, factIds: [F6.id] }];
  let briefingCount = 0;
  let pageCount = 0;

  const app = createAppSession({
    seedRecord: seed,
    label: "H1 재시도 프로브",
    auditOutputs: false,
    probe: true,
    meta: {
      role: "probe",
      expectedFacts: expectedConfirmedFacts,
      existingIds: Array.from(allFixtureIds),
      forbiddenFacts: [{ id: F6.id, text: F6.text, label: "거절된 F6" }],
      nonConfirmedTexts: [F6.text]
    },
    fetchHandler: async (ctx) => {
      if (ctx.kind === "briefing") {
        briefingCount += 1;
        return modelResponse({
          lines: briefingCount === 1 ? invalidSentences : validBriefing
        });
      }
      if (ctx.kind === "page") {
        pageCount += 1;
        return modelResponse({
          sentences: pageCount === 1 ? invalidSentences : validPage
        });
      }
      return undefined;
    }
  });

  app.click("goto-confirmed-btn");
  app.click("open-preview-btn");
  await ensurePreview(app, 0);
  app.click("open-bedtime-btn");
  await ensurePage(app, 0);

  return {
    app,
    briefingCount,
    pageCount,
    final: app.currentRaw()
  };
}

// ---------------------------------------------------------------------------
// Check 3: real correction path (fake extraction response, real UI handlers)
// ---------------------------------------------------------------------------

function findCandidateCard(app, text) {
  const list = app.element("candidate-list");
  for (const card of list.children || []) {
    const textElement = findDescendant(card, (child) => hasClass(child, "candidate-text"));
    if (textElement && nfc(textElement.textContent) === nfc(text)) return card;
  }
  return null;
}

function clickCardButton(app, card, label) {
  const buttons = findDescendants(card, (child) =>
    child.tagName === "button" && child.textContent.trim() === label);
  if (buttons.length === 0) throw new Error("후보 카드 버튼을 찾을 수 없다: " + label);
  buttons[0].click();
}

async function runCorrectionSession() {
  const { checks, assert } = makeChecks();
  const v1Composed = composedFixtureRecord();
  const v1Ids = new Set(v1Composed.candidates.map((c) => c.id));
  const correctedMemo = fixture.memo.text.replace("한 달", "두 달");
  const correctedText = F10.text.replace("한 달", "두 달");

  // The extraction response reuses old F10 for the corrected text. No harness
  // pre-repair: this exact object is what the app receives.
  const extractionRaw = {
    candidates: fixtureCandidates.map((c) => ({
      id: c.id,
      text: c.id === "F10" ? correctedText : c.text,
      source: c.source,
      grade: c.grade
    })),
    unknowns: deepClone(fixture.unknowns)
  };
  const extractionContent = JSON.stringify(extractionRaw);

  const app = createAppSession({
    seedRecord: v1Composed,
    label: "검사 3 정정 경로 (F10 재사용 주입)",
    auditOutputs: false,
    probe: true,
    meta: { correctedText, correctedMemo },
    fetchHandler: async (ctx) => {
      if (ctx.kind === "extraction") {
        return jsonResponse({
          choices: [{ message: { content: extractionContent } }]
        });
      }
      return undefined;
    }
  });

  app.click("edit-memo-btn");
  app.setValue("memo-input", correctedMemo);
  app.trigger("memo-input", "input");
  const afterMemo = app.currentRaw();
  assert("메모 수정 후 앱 무효화", invalidationOk(afterMemo, correctedMemo),
    afterMemo && afterMemo.__parseError ? "저장 상태 파싱 실패: " + afterMemo.__parseError
      : "메모 input 후 후보/합성물이 남아 있다");

  app.element("photo-input").files = [{ name: "s7-correction-probe.jpg" }];
  app.trigger("photo-input", "change");
  const afterPhoto = app.currentRaw();
  assert("사진 변경 후 메모 유지", afterPhoto && afterPhoto.memoText === correctedMemo,
    "사진 변경이 정정 메모를 지웠다");

  app.click("extract-btn");
  await app.waitFor(() => {
    const record = app.currentRaw();
    return (record && Array.isArray(record.candidates) && record.candidates.length > 0) ||
      app.errorText("capture-error") !== "";
  });
  const extractionError = app.errorText("capture-error");
  const afterExtract = app.currentRaw();
  assert("재추출 응답 적용", afterExtract && Array.isArray(afterExtract.candidates) &&
    afterExtract.candidates.length > 0 && extractionError === "",
    extractionError || "재추출 후보가 없다");

  if (afterExtract && Array.isArray(afterExtract.candidates) &&
      afterExtract.candidates.length > 0 && extractionError === "") {
    for (const candidate of afterExtract.candidates) {
      const card = findCandidateCard(app, candidate.text);
      if (!card) {
        assert("후보 카드 렌더", false, "후보 카드를 찾을 수 없다: " + candidate.text);
        break;
      }
      // A3 remaps every burned ID, so identify the F6 candidate by its
      // fixture text, not by an ID that the app is expected to replace.
      clickCardButton(app, card,
        nfc(candidate.text) === nfc(F6.text) ? "거절" : "확정");
    }
    await app.waitFor(() => {
      const record = app.currentRaw();
      return record && record.gate1Complete === true;
    }, RENDER_WAIT_MS);
    const decided = app.currentRaw();
    assert("재확정 완료", decided && decided.gate1Complete === true,
      "재추출 후보를 모두 결정하지 못했다");
    app.click("goto-confirmed-btn");
  }

  const finalRecord = app.currentRaw();
  return {
    app,
    checks,
    v1Composed,
    v1Ids,
    correctedMemo,
    correctedText,
    extractionRaw,
    extractionContent,
    afterMemo,
    afterPhoto,
    afterExtract,
    finalRecord,
    extractionError
  };
}

// ---------------------------------------------------------------------------
// Check 3: stale-composition re-entry guards + live v2 recomposition.
// The same storage map is reused (H6); no seed is recreated.
// ---------------------------------------------------------------------------

async function runGuardAndV2LiveSession(correction) {
  const { checks, assert } = makeChecks();
  const { app: correctionApp, finalRecord, correctedText } = correction;
  if (!finalRecord || !Array.isArray(finalRecord.candidates) ||
      finalRecord.candidates.length === 0) {
    assert("v2 재진입 준비", false, "정정 경로가 후보를 만들지 못해 재진입 검사를 진행할 수 없다");
    return { checks, skipped: true, guardPreview: null, guardPage: null, finalRecord: null };
  }

  const staleRecord = Object.assign({}, deepClone(finalRecord), {
    briefing: deepClone(correction.v1Composed.briefing),
    pageSentences: deepClone(correction.v1Composed.pageSentences)
  });
  const staleJson = TawCore.serialize(staleRecord);
  if (staleJson === null) {
    assert("v2 재진입 준비", false, "stale 합성 시드를 직렬화할 수 없다");
    return { checks, skipped: true, guardPreview: null, guardPage: null, finalRecord };
  }
  correctionApp.storage.map.set(TawCore.STORAGE_KEY, staleJson);

  const expectedV2Facts = confirmedFromRecord(finalRecord);
  const expectedV2Ids = new Set(expectedV2Facts.map((f) => f.id));
  const correctedMatches = finalRecord.candidates.filter((c) => nfc(c.text) === nfc(correctedText));
  const correctedFact = correctedMatches.length === 1 ? correctedMatches[0] : null;
  const finalId = correctedFact ? correctedFact.id : null;
  const forbiddenFacts = [{ id: F6.id, text: F6.text, label: "거절된 F6" }];
  if (!finalId || finalId !== F10.id) {
    forbiddenFacts.push({ id: F10.id, text: F10.text, label: "구 세대 F10" });
  }
  const nonConfirmedTexts = finalRecord.candidates
    .filter((c) => c.decision !== "confirmed")
    .map((c) => c.text);

  const guardKinds = new Set(["briefing", "page"]);
  let pending = [];

  const app = createAppSession({
    storage: correctionApp.storage,
    label: "검사 3 v2 재진입 + 라이브",
    live: true,
    auditOutputs: true,
    meta: {
      role: "v2",
      expectedFacts: expectedV2Facts,
      existingIds: finalRecord.candidates.map((c) => c.id),
      forbiddenFacts,
      nonConfirmedTexts,
      finalId,
      correctedId: finalId,
      correctedText
    },
    fetchHandler: async (ctx) => {
      if (guardKinds.has(ctx.kind)) {
        return await new Promise((resolve, reject) => {
          pending.push({ ctx, resolve, reject });
        });
      }
      return undefined;
    }
  });

  async function releaseGuard(kind) {
    const index = pending.findIndex((entry) => entry.ctx.kind === kind);
    if (index === -1) return false;
    const entry = pending[index];
    pending = pending.filter((_, i) => i !== index);
    guardKinds.delete(kind);
    try {
      const response = await liveFetchResponse(entry.ctx);
      entry.resolve(response);
      return true;
    } catch (err) {
      entry.reject(err);
      return false;
    }
  }

  app.click("goto-confirmed-btn");

  // --- Preview entry guard -------------------------------------------------
  const previewBefore = app.session.requests.length;
  app.click("open-preview-btn");
  const previewRecord = app.currentRaw();
  const previewRendered = app.renderedBriefing();
  const previewIssued = app.session.requests
    .slice(previewBefore)
    .some((request) => request.kind === "briefing");
  const previewStaleServed = previewRendered.some((sentence) =>
    sentence.factIds.includes("F10") || nfc(sentence.text) === nfc(F10.text));
  const guardPreview = {
    requestIssued: previewIssued,
    storedCleared: !!previewRecord && previewRecord.briefing === null,
    renderEmpty: previewRendered.length === 0,
    staleServed: previewStaleServed,
    ok: previewIssued && !!previewRecord && previewRecord.briefing === null &&
      previewRendered.length === 0 && !previewStaleServed
  };
  assert("프리뷰 입구 가드", guardPreview.ok,
    "낡은 브리핑 비서빙/재합성 실패: " + JSON.stringify({
      requestIssued: previewIssued,
      storedCleared: guardPreview.storedCleared,
      renderEmpty: guardPreview.renderEmpty,
      staleServed: previewStaleServed
    }));

  if (pending.some((entry) => entry.ctx.kind === "briefing")) {
    await releaseGuard("briefing");
  } else {
    guardKinds.delete("briefing");
    app.click("resynthesize-btn"); // guard가 실패한 경우에도 v2 라이브 출력을 얻는다
  }
  await ensurePreview(app, LIVE_SESSION_RETRIES);

  // --- Bedtime entry guard ------------------------------------------------
  const pageBefore = app.session.requests.length;
  app.click("open-bedtime-btn");
  const pageRecord = app.currentRaw();
  const pageRendered = app.renderedPage();
  const pageIssued = app.session.requests
    .slice(pageBefore)
    .some((request) => request.kind === "page");
  const pageStaleServed = pageRendered.some((sentence) =>
    sentence.factIds.includes("F10") || nfc(sentence.text) === nfc(F10.text));
  const guardPage = {
    requestIssued: pageIssued,
    storedCleared: !!pageRecord && Array.isArray(pageRecord.pageSentences) &&
      pageRecord.pageSentences.length === 0,
    renderEmpty: pageRendered.length === 0,
    staleServed: pageStaleServed,
    ok: pageIssued && !!pageRecord && Array.isArray(pageRecord.pageSentences) &&
      pageRecord.pageSentences.length === 0 && pageRendered.length === 0 && !pageStaleServed
  };
  assert("취침 입구 가드", guardPage.ok,
    "낡은 페이지 비서빙/재합성 실패: " + JSON.stringify({
      requestIssued: pageIssued,
      storedCleared: guardPage.storedCleared,
      renderEmpty: guardPage.renderEmpty,
      staleServed: pageStaleServed
    }));

  if (pending.some((entry) => entry.ctx.kind === "page")) {
    await releaseGuard("page");
  } else {
    guardKinds.delete("page");
    app.click("recompose-btn"); // guard가 실패한 경우에도 v2 라이브 출력을 얻는다
  }
  await ensurePage(app, LIVE_SESSION_RETRIES);

  // Coverage retry only when the served page is otherwise clean: an earlier
  // forbidden-content violation is never erased (H6), but a clean page that
  // simply omits the corrected fact may be recomposed once more.
  if (finalId) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record = app.currentRaw();
      const page = record && Array.isArray(record.pageSentences) ? record.pageSentences : [];
      const cited = page.some((sentence) =>
        sentence && Array.isArray(sentence.factIds) && sentence.factIds.includes(finalId));
      if (cited) break;
      addNote("정정 사실 미인용 — 같은 세션에서 재합성 시도 " + (attempt + 1));
      app.click("recompose-btn");
      await ensurePage(app, 0);
    }
  }

  const finalV2 = app.currentRaw();
  return {
    app,
    checks,
    skipped: false,
    guardPreview,
    guardPage,
    finalRecord: finalV2,
    expectedV2Facts,
    expectedV2Ids,
    correctedFact,
    finalId,
    renderedBriefing: app.renderedBriefing(),
    renderedPage: app.renderedPage()
  };
}

// ---------------------------------------------------------------------------
// Cross-session audit (H1 requests + H6 accumulated outputs)
// ---------------------------------------------------------------------------

function priorContextForRequest(session, requestIndex) {
  const priorTexts = [];
  const priorSnippets = [];
  for (const output of session.outputs) {
    if (output.requestIndex >= requestIndex) continue;
    if (output.kind !== "briefing" && output.kind !== "page") continue;
    if (output.content && (output.parseError || output.contractError)) {
      if (output.rawSnippet) priorSnippets.push(output.rawSnippet);
    }
    for (const sentence of output.sentences) {
      if (sentence.text) priorTexts.push(sentence.text);
    }
  }
  return { priorTexts, priorSnippets };
}

function auditAllRequests() {
  let synthesisRequests = 0;
  let extractionRequests = 0;
  for (const session of ledger.sessions) {
    const meta = session.meta || {};
    session.requests.forEach((request) => {
      if (request.kind === "extraction") {
        extractionRequests += 1;
        if (request.parseError) {
          addViolation(2, {
            where: "H1 추출 요청 구조 — " + session.label + " 요청 " + (request.requestIndex + 1),
            reason: "추출 요청 본문을 파싱할 수 없다: " + request.parseError
          }, { session: session.label, attempt: request.requestIndex + 1 });
        } else if (request.payload && Array.isArray(request.payload.messages) &&
            Array.isArray(request.payload.messages[1] &&
              request.payload.messages[1].content)) {
          const parts = request.payload.messages[1].content;
          const textPart = parts.find((part) => part && part.type === "text");
          const imagePart = parts.find((part) => part && part.type === "image_url");
          if (!textPart || !imagePart) {
            addViolation(2, {
              where: "H1 추출 요청 구조 — " + session.label + " 요청 " + (request.requestIndex + 1),
              reason: "추출 user 메시지가 text+image_url 구조가 아니다"
            }, { session: session.label, attempt: request.requestIndex + 1 });
          }
        }
        return;
      }
      if (!Array.isArray(meta.expectedFacts)) return;
      if (request.kind !== "briefing" && request.kind !== "page") return;
      synthesisRequests += 1;
      const prior = priorContextForRequest(session, request.requestIndex);
      const label = session.label + " / " + request.kind + " 요청 " + (request.requestIndex + 1);
      const result = auditSynthesisRequest(request.body, {
        label,
        expectedFacts: meta.expectedFacts,
        forbiddenFacts: meta.forbiddenFacts || [],
        nonConfirmedTexts: meta.nonConfirmedTexts || [],
        priorTexts: prior.priorTexts,
        priorSnippets: prior.priorSnippets,
        existingIds: new Set(meta.expectedFacts.map((f) => f.id))
      });
      for (const violation of result.violations) {
        addViolation(2, violation, {
          session: session.label,
          attempt: request.requestIndex + 1
        });
      }
    });
  }
  return { synthesisRequests, extractionRequests };
}

function scanOutputForF6(label, sentences, nonConfirmedTexts, add) {
  for (const sentence of sentenceList(sentences)) {
    if (sentence.factIds.includes(F6.id)) {
      add({
        where: label,
        reason: "시도/서빙 출력이 거절된 F6를 인용했다",
        text: sentence.text
      });
    }
    for (const marker of markerHits(sentence.text)) {
      add({
        where: label,
        reason: "시도/서빙 출력에 F6 내용 마커가 있다: " + marker,
        text: sentence.text
      });
    }
    for (const candidateText of nonConfirmedTexts || []) {
      if (nfc(candidateText) !== "" && nfc(sentence.text).includes(nfc(candidateText))) {
        add({
          where: label,
          reason: "시도/서빙 출력에 확정 집합 밖 후보 전문이 있다",
          text: sentence.text
        });
      }
    }
  }
}

function auditAllOutputs() {
  for (const session of ledger.sessions) {
    if (!session.auditOutputs) continue;
    const meta = session.meta || {};
    if (!Array.isArray(meta.expectedFacts)) continue;
    const allowedIds = new Set(meta.expectedFacts.map((f) => f.id));
    const existingIds = new Set(meta.existingIds || meta.expectedFacts.map((f) => f.id));
    for (const output of session.outputs) {
      if (output.kind !== "briefing" && output.kind !== "page") continue;
      const label = session.label + " / " + output.kind + " 시도 " + (output.requestIndex + 1);
      if (output.parseError || output.contractError) {
        // A model attempt that cannot be parsed is not a served sentence and is
        // not itself a citation violation: the app's retry/fallback path owns it.
        // H6 still keeps the output in the ledger, and forbidden content that is
        // visible in the raw text is scanned and retained below.
        const reason = output.parseError || output.contractError;
        addIncident("합성 시도 출력 계약 실패 — 재시도/폴백으로 진행: " + label + " — " + reason, {
          session: session.label,
          attempt: output.requestIndex + 1
        });
        if (output.content) {
          scanOutputForF6(
            label + " (원문 스캔)",
            [{ text: output.content, factIds: [] }],
            meta.nonConfirmedTexts,
            (violation) => {
              addViolation(2, violation, {
                session: session.label,
                attempt: output.requestIndex + 1
              });
            }
          );
        }
        continue;
      }
      const citationViolations = auditSentences(
        label,
        output.sentences,
        allowedIds,
        existingIds
      );
      for (const violation of citationViolations) {
        addViolation(1, violation, {
          session: session.label,
          attempt: output.requestIndex + 1
        });
      }
      scanOutputForF6(label, output.sentences, meta.nonConfirmedTexts, (violation) => {
        addViolation(2, violation, {
          session: session.label,
          attempt: output.requestIndex + 1
        });
      });
      if (meta.correctedId) {
        const tokenViolations = [];
        scanOldValueTokens(label, output.sentences, meta.correctedId, tokenViolations);
        for (const violation of tokenViolations) {
          addViolation(3, violation, {
            session: session.label,
            attempt: output.requestIndex + 1
          });
        }
      }
    }
  }
}

function auditServed(kind, label, stored, rendered, config) {
  const violations1 = [];
  const violations2 = [];
  const violations3 = [];
  const storedList = Array.isArray(stored) ? stored : [];
  const renderedList = Array.isArray(rendered) ? rendered : [];

  if (storedList.length === 0) {
    violations1.push({ where: label + " 저장", reason: "최종 서빙 " + kind + "이 없다", text: "" });
  }
  if (renderedList.length === 0) {
    violations1.push({ where: label + " 렌더링", reason: "렌더링된 " + kind + "이 없다", text: "" });
  }
  if (!sameSentenceList(storedList, renderedList)) {
    violations1.push({
      where: label + " H2 저장↔렌더",
      reason: "저장 문장과 화면 요소에 쓰인 문장이 일치하지 않는다",
      text: JSON.stringify({ stored: sentenceList(storedList), rendered: sentenceList(renderedList) })
    });
  }

  violations1.push(...auditSentences(
    label + " 저장",
    storedList,
    config.allowedIds,
    config.existingIds
  ));
  violations1.push(...auditSentences(
    label + " 렌더링",
    renderedList,
    config.allowedIds,
    config.existingIds
  ));

  scanOutputForF6(label + " 저장", storedList, config.nonConfirmedTexts, (violation) => {
    violations2.push(violation);
  });
  scanOutputForF6(label + " 렌더링", renderedList, config.nonConfirmedTexts, (violation) => {
    violations2.push(violation);
  });

  if (config.correctedId) {
    scanOldValueTokens(label + " 저장", storedList, config.correctedId, violations3);
    scanOldValueTokens(label + " 렌더링", renderedList, config.correctedId, violations3);
  }

  for (const violation of violations1) addViolation(1, violation, { session: label });
  for (const violation of violations2) addViolation(2, violation, { session: label });
  for (const violation of violations3) addViolation(3, violation, { session: label });

  return { violations1, violations2, violations3 };
}

function auditSessionGateCalls() {
  for (const session of ledger.sessions) {
    if (!session.auditOutputs) continue;
    const meta = session.meta || {};
    if (!Array.isArray(meta.expectedFacts)) continue;
    const expectedIds = meta.expectedFacts.map((f) => f.id);
    session.gateCalls.forEach((call, index) => {
      const label = session.label + " 앱 게이트 " + (index + 1);
      if (!sameIdSet(call.allowedIds, expectedIds)) {
        addViolation(1, {
          where: label,
          reason: "앱 게이트의 허용 ID 집합이 기대 확정 집합과 다르다: " +
            call.allowedIds.join(","),
          text: ""
        }, { session: session.label, attempt: index + 1 });
      }
      if (call.allowedIds.includes(F6.id)) {
        addViolation(1, {
          where: label,
          reason: "앱 게이트 허용 집합에 거절된 F6가 들어 있다",
          text: F6.text
        }, { session: session.label, attempt: index + 1 });
      }
      if (meta.finalId && meta.finalId !== F10.id && call.allowedIds.includes(F10.id)) {
        addViolation(3, {
          where: label,
          reason: "v2 앱 게이트 허용 집합에 구 세대 F10이 들어 있다",
          text: ""
        }, { session: session.label, attempt: index + 1 });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Check 1 deterministic base
// ---------------------------------------------------------------------------

function check1Deterministic() {
  const violations = [];
  const staticViolations = auditSentences(
    "검사 1 정적(exampleState.pageSentences)",
    fixture.exampleState.pageSentences,
    expectedConfirmedSet,
    allFixtureIds
  );
  violations.push(...staticViolations);

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
    gateProbe.detail = "앱 게이트 호출 실패(관찰 불가): " + err.message;
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

// ---------------------------------------------------------------------------
// Check 3 relation assertions
// ---------------------------------------------------------------------------

function evaluateCorrectionRelation(correction) {
  const { checks, assert } = makeChecks();
  const finalRecord = correction.finalRecord;
  const correctedText = correction.correctedText;
  const v1Ids = correction.v1Ids;

  if (!finalRecord || finalRecord.__parseError) {
    assert("현재 레코드", false, "정정 후 현재 레코드를 읽을 수 없다");
    return { checks, correctedFact: null, finalId: null, finalConfirmed: [] };
  }

  const matches = finalRecord.candidates.filter((c) => nfc(c.text) === nfc(correctedText));
  const correctedFact = matches.length === 1 ? matches[0] : null;
  assert("정정 사실 유일", matches.length === 1,
    "정정 텍스트를 가진 후보가 정확히 1개가 아니다: " + matches.length);

  const finalId = correctedFact ? correctedFact.id : null;
  if (correctedFact) {
    assert("정정 사실 새 ID", finalId !== F10.id,
      "정정 사실이 구 F10 ID를 그대로 쓴다");
    assert("정정 사실 ID 비충돌", !v1Ids.has(finalId),
      "정정 사실 ID가 v1 후보 ID를 재사용한다: " + finalId);
    assert("정정 사실 확정", correctedFact.decision === "confirmed",
      "정정 사실이 확정 상태가 아니다: " + correctedFact.decision);
  }

  const finalConfirmed = confirmedFromRecord(finalRecord);
  // A3 burns every candidate ID of the invalidated generation, so v2 may
  // renumber the untouched facts too. The invariant is textual: exactly the
  // F10 fact is replaced by the corrected text and the other 11 texts survive.
  const expectedOtherTexts = expectedConfirmedFacts
    .filter((f) => f.id !== "F10")
    .map((f) => nfc(f.text))
    .sort();
  const actualOtherTexts = finalConfirmed
    .filter((f) => nfc(f.text) !== nfc(correctedText))
    .map((f) => nfc(f.text))
    .sort();
  const othersMatch = JSON.stringify(expectedOtherTexts) === JSON.stringify(actualOtherTexts);
  const confirmedIds = finalConfirmed.map((f) => f.id);
  const reusedGenerationIds = confirmedIds.filter((id) => v1Ids.has(id));
  const relationOk = finalConfirmed.length === 12 &&
    new Set(confirmedIds).size === 12 &&
    othersMatch &&
    !!correctedFact &&
    reusedGenerationIds.length === 0;
  assert("v2 확정 집합 관계", relationOk,
    "v2 확정 집합이 '구 세대 12개 중 F10 텍스트만 정정 사실로 치환, ID는 새 세대' 관계가 아니다. " +
    "포착=" + confirmedIds.join(",") +
    (othersMatch ? "" : " / 미일치 텍스트가 있다") +
    (reusedGenerationIds.length > 0
      ? " / 구 세대 ID 재사용: " + reusedGenerationIds.join(",")
      : ""));

  assert("현재 레코드 정정 텍스트 해소",
    !!correctedFact && correctedFact.id === finalId && nfc(correctedFact.text) === nfc(correctedText),
    "최종 ID가 정정 텍스트로 해소되지 않는다");

  const oldF10TextCurrent = finalRecord.candidates.some((c) =>
    nfc(c.text) === nfc(F10.text));
  assert("현재 레코드 구 F10 텍스트 부재", !oldF10TextCurrent,
    "현재 후보에 구 F10 텍스트('한 달')가 남아 있다");

  const oldF10IdCurrent = finalRecord.candidates.some((c) => c.id === F10.id && c.id !== finalId);
  assert("현재 레코드 구 F10 ID 부재", !oldF10IdCurrent,
    "현재 후보에 구 F10 ID가 별도 사실로 남아 있다");

  assert("결정 후 합성물 초기화",
    finalRecord.briefing === null &&
    Array.isArray(finalRecord.pageSentences) && finalRecord.pageSentences.length === 0,
    "후보 결정 변경 후 브리핑/페이지가 초기화되지 않았다");

  return { checks, correctedFact, finalId, finalConfirmed };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printSelfTests(selfTests) {
  for (const test of selfTests) {
    log("    " + (test.ok ? "ok  " : "FAIL") + " " + test.name +
      (!test.ok && test.violations.length > 0
        ? " — 잡힌 사유: " + test.violations.map((v) => v.reason).join(" / ")
        : ""));
  }
}

function printCheckHeader(title, violations) {
  log("[" + title + "] " + (violations.length === 0 ? "PASS" : "FAIL"));
}

function printCheckViolations(violations) {
  if (violations.length === 0) return;
  log("  위반 상세 (누적 " + violations.length + "건):");
  for (const violation of violations) {
    log("    - [" + (violation.session || "harness") + "] " + violation.where + ": " +
      violation.reason + (violation.text ? " | \"" + violation.text + "\"" : ""));
  }
}

function requestCounts() {
  const counts = { briefing: 0, page: 0, extraction: 0, other: 0 };
  for (const request of ledger.requests) {
    if (counts[request.kind] === undefined) counts.other += 1;
    else counts[request.kind] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log("S7 counterfactual harness v2 — Astra review fixes (2026-11-01)");
  log("fixture: fixtures/deuri-day.json  sha256=" + fixtureHashBefore +
    "  [하니스 장부: fixture 무결성 증거]");
  log("expected confirmed (fixture exampleState.confirmed): " + expectedConfirmedIds.join(", "));
  log("expected rejected: " + expectedRejectedIds.join(", "));
  log("F6 markers (derived from fixture F6, NFC-normalized scans): " +
    F6_MARKERS.map((m) => m.name).join(", "));
  log("H4 old-value tokens (token-level guard, not semantic): " +
    OLD_VALUE_TOKENS.map((t) => "\"" + t.token + "\"").join(", "));
  log("H2 scope: harness DOM에 실제로 쓰인 문장 판정. 실브라우저 렌더링 차이는 범위 밖 " +
    "(S13 기기 재생 + S6 E2E).");
  log("버전 인터페이스 한계: 앱에 페이지 버전 식별자/이력이 없다 — 버전 이력 보존은 단언하지 않는다.");
  log("");

  // Deterministic checks first. Their violations enter the append-only ledger.
  const det1 = check1Deterministic();
  for (const violation of det1.violations) addViolation(1, violation, { session: "deterministic" });

  const det2 = check2Deterministic();
  for (const violation of det2.violations) addViolation(2, violation, { session: "deterministic" });

  const v1Composed = composedFixtureRecord();
  const correctedMemo = fixture.memo.text.replace("한 달", "두 달");
  const correctedText = F10.text.replace("한 달", "두 달");
  const invalidation = runInvalidationProbes(v1Composed, correctedMemo);
  for (const check of invalidation.checks) {
    if (!check.ok) {
      addViolation(3, {
        where: "검사 3 " + check.name,
        reason: check.detail || check.name
      }, { session: "deterministic" });
    }
  }

  // H1 counterfactual retry probe (intentional violation injected).
  let h1Probe = null;
  try {
    h1Probe = await runH1RetryProbeSession();
  } catch (err) {
    addIncident("H1 재시도 프로브 실행 실패: " + (err.stack || err), { session: "H1 재시도 프로브" });
    addViolation(2, {
      where: "H1 재시도 프로브",
      reason: "실행 실패: " + (err.message || String(err))
    }, { session: "H1 재시도 프로브" });
  }

  // Live v1: shared by check 1 (served output) and check 2 (full requests).
  let liveV1 = null;
  try {
    liveV1 = await runLiveV1Session();
  } catch (err) {
    addIncident("live v1 실행 실패: " + (err.stack || err), { session: "live v1" });
    addViolation(1, {
      where: "검사 1 live v1",
      reason: "실행 실패: " + (err.message || String(err))
    }, { session: "live v1" });
  }

  // Check 3 real correction path: fake extraction response reuses F10.
  let correction = null;
  try {
    correction = await runCorrectionSession();
  } catch (err) {
    addIncident("검사 3 정정 경로 실행 실패: " + (err.stack || err), { session: "검사 3 정정 경로" });
    addViolation(3, {
      where: "검사 3 정정 경로",
      reason: "실행 실패: " + (err.message || String(err))
    }, { session: "검사 3 정정 경로" });
  }
  if (correction) {
    for (const check of correction.checks) {
      if (!check.ok) {
        addViolation(3, {
          where: "검사 3 " + check.name,
          reason: check.detail || check.name
        }, { session: "검사 3 정정 경로" });
      }
    }
  }

  // Check 3 re-entry + live v2, same storage map.
  let guard = null;
  if (correction && correction.finalRecord) {
    try {
      guard = await runGuardAndV2LiveSession(correction);
    } catch (err) {
      addIncident("검사 3 v2 재진입 실행 실패: " + (err.stack || err), { session: "검사 3 v2" });
      addViolation(3, {
        where: "검사 3 v2 재진입",
        reason: "실행 실패: " + (err.message || String(err))
      }, { session: "검사 3 v2" });
    }
  }
  if (guard) {
    for (const check of guard.checks) {
      if (!check.ok) {
        addViolation(3, {
          where: "검사 3 " + check.name,
          reason: check.detail || check.name
        }, { session: "검사 3 v2" });
      }
    }
  }

  // H1 request audits across every session (append-only).
  const requestStats = auditAllRequests();
  auditAllOutputs();
  auditSessionGateCalls();

  if (h1Probe) {
    if (h1Probe.briefingCount < 2) {
      addViolation(2, {
        where: "H1 재시도 프로브 — 브리핑",
        reason: "위반 응답 후 두 번째 합성 요청이 발생하지 않았다 (요청 " +
          h1Probe.briefingCount + "건)"
      }, { session: h1Probe.app.label });
    }
    if (h1Probe.pageCount < 2) {
      addViolation(2, {
        where: "H1 재시도 프로브 — 페이지",
        reason: "위반 응답 후 두 번째 합성 요청이 발생하지 않았다 (요청 " +
          h1Probe.pageCount + "건)"
      }, { session: h1Probe.app.label });
    }
  }

  // Check 1 served-output audits and H2 storage <-> render equality.
  if (liveV1 && liveV1.final) {
    const v1Config = {
      allowedIds: expectedConfirmedSet,
      existingIds: allFixtureIds,
      nonConfirmedTexts: [F6.text]
    };
    auditServed(
      "브리핑",
      "검사 1 live v1 브리핑",
      liveV1.final.briefing,
      liveV1.renderedBriefing,
      v1Config
    );
    auditServed(
      "페이지",
      "검사 1 live v1 페이지",
      liveV1.final.pageSentences,
      liveV1.renderedPage,
      v1Config
    );
  } else {
    addViolation(1, {
      where: "검사 1 live v1",
      reason: "라이브 v1 결과가 없어 서빙 출력을 판정할 수 없다"
    }, { session: "live v1" });
  }

  // Check 3 relation assertions (current record, not version history).
  let relation = null;
  if (correction) {
    relation = evaluateCorrectionRelation(correction);
    for (const check of relation.checks) {
      if (!check.ok) {
        addViolation(3, {
          where: "검사 3 " + check.name,
          reason: check.detail || check.name
        }, { session: "검사 3 정정 경로" });
      }
    }
  } else {
    addViolation(3, {
      where: "검사 3 현재 레코드",
      reason: "정정 경로가 실행되지 않아 최종 ID 관계를 단언할 수 없다"
    }, { session: "검사 3 정정 경로" });
  }

  // Check 3 v2 served output + H4 token guard.
  if (guard && !guard.skipped && guard.finalRecord) {
    const currentIds = new Set(guard.finalRecord.candidates.map((c) => c.id));
    const existingV2Ids = new Set([
      ...Array.from(guard.expectedV2Ids),
      ...Array.from(currentIds)
    ]);
    const v2Config = {
      allowedIds: guard.expectedV2Ids,
      existingIds: existingV2Ids,
      nonConfirmedTexts: guard.finalRecord.candidates
        .filter((c) => c.decision !== "confirmed")
        .map((c) => c.text),
      correctedId: guard.finalId
    };
    auditServed(
      "브리핑",
      "검사 3 v2 브리핑",
      guard.finalRecord.briefing,
      guard.renderedBriefing,
      v2Config
    );
    auditServed(
      "페이지",
      "검사 3 v2 페이지",
      guard.finalRecord.pageSentences,
      guard.renderedPage,
      v2Config
    );

    if (!guard.finalId) {
      addViolation(3, {
        where: "검사 3 v2 현재 레코드",
        reason: "정정 사실 ID가 없어 v2 출력 관계를 단언할 수 없다"
      }, { session: "검사 3 v2" });
    } else {
      const resolved = guard.finalRecord.candidates.find((c) => c.id === guard.finalId);
      if (!resolved || nfc(resolved.text) !== nfc(correction.correctedText)) {
        addViolation(3, {
          where: "검사 3 v2 현재 레코드",
          reason: "최종 ID가 정정 텍스트로 해소되지 않는다: " + guard.finalId,
          text: resolved ? resolved.text : "(없음)"
        }, { session: "검사 3 v2" });
      }
      const page = Array.isArray(guard.finalRecord.pageSentences)
        ? guard.finalRecord.pageSentences
        : [];
      const citesCorrected = page.some((sentence) =>
        sentence && Array.isArray(sentence.factIds) && sentence.factIds.includes(guard.finalId));
      if (!citesCorrected) {
        addViolation(3, {
          where: "검사 3 v2 페이지",
          reason: "정정 사실의 최종 ID를 인용하는 문장이 없다: " + guard.finalId
        }, { session: "검사 3 v2" });
      }
      if (guard.finalId !== F10.id) {
        const oldIdCitations = page.concat(Array.isArray(guard.finalRecord.briefing)
          ? guard.finalRecord.briefing : [])
          .filter((sentence) => sentence && Array.isArray(sentence.factIds) &&
            sentence.factIds.includes(F10.id));
        if (oldIdCitations.length > 0) {
          addViolation(3, {
            where: "검사 3 v2 출력",
            reason: "v2 출력이 구 세대 F10 ID를 인용했다",
            text: oldIdCitations[0].text || ""
          }, { session: "검사 3 v2" });
        }
      }
    }
  } else {
    addViolation(3, {
      where: "검사 3 v2 서빙",
      reason: "v2 재진입/재합성이 실행되지 않아 최종 출력을 판정할 수 없다"
    }, { session: "검사 3 v2" });
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  const check1Violations = violationsFor(1);
  printCheckHeader("검사 1 — 인용 무결성 (하네스 독립 오라클, H2 렌더링 포함)", check1Violations);
  log("  결정론 층");
  printSentences("정적 exampleState.pageSentences", fixture.exampleState.pageSentences);
  log("  반사실 게이트 프로브 (앱 validateComposition은 피검 대상): " + det1.gateProbe.detail);
  log("  라이브 층 (실제 Worker/모델, web/app.js 최종 서빙 출력 + 하니스 DOM 렌더링)");
  if (liveV1 && liveV1.final) {
    log("    live v1 요청 " + liveV1.app.session.requests.length + "건, 시도 출력 " +
      liveV1.app.session.outputs.length + "건");
    printSentences("저장 브리핑", liveV1.final.briefing);
    printSentences("렌더링 브리핑", liveV1.renderedBriefing);
    printSentences("저장 페이지", liveV1.final.pageSentences);
    printSentences("렌더링 페이지", liveV1.renderedPage);
  } else {
    log("    (라이브 v1 결과 없음)");
  }
  if (guard && !guard.skipped && guard.finalRecord) {
    log("    live v2 요청 " + guard.app.session.requests.length + "건, 시도 출력 " +
      guard.app.session.outputs.length + "건");
    printSentences("저장 브리핑", guard.finalRecord.briefing);
    printSentences("렌더링 브리핑", guard.renderedBriefing);
    printSentences("저장 페이지", guard.finalRecord.pageSentences);
    printSentences("렌더링 페이지", guard.renderedPage);
  } else {
    log("    (라이브 v2 결과 없음)");
  }
  log("  H2: 저장↔렌더링 일치 단언 완료. 실브라우저 렌더링 차이는 범위 밖 " +
    "(S13 기기 재생 + S6 E2E).");
  printCheckViolations(check1Violations);
  log("");

  const check2Violations = violationsFor(2);
  printCheckHeader("검사 2 — 합성 경계/H1 전체 요청 본문", check2Violations);
  log("  결정론 층 (합성 입력 포착 + 스캐너 자기검증)");
  log("    (a) 포착: " + (det2.capture1 ? det2.capture1.map((f) => f.id).join(", ") : "없음"));
  log("        기대: " + expectedConfirmedFacts.map((f) => f.id).join(", "));
  log("        F6 부재: " + (det2.capture1 && !det2.capture1.some((f) => f.id === "F6")
    ? "예" : "아니오"));
  log("    (b) 미결정 마커 추가 후 포착: " +
    (det2.capture2 ? det2.capture2.map((f) => f.id).join(", ") : "없음") +
    " / (a)와 동일: " + (det2.capture1 && det2.capture2 &&
      sameFacts(det2.capture1, det2.capture2) ? "예" : "아니오"));
  log("    H1/H5 스캐너 자기검증:");
  printSelfTests(det2.selfTests);
  log("  H1 재시도 프로브 (의도적으로 위반 응답 주입, 실제 앱 재시도 루프 통과):");
  if (h1Probe) {
    log("    브리핑 요청 " + h1Probe.briefingCount + "건 / 페이지 요청 " +
      h1Probe.pageCount + "건 — 두 번째 요청 본문까지 판정 대상");
  } else {
    log("    (실행되지 않음)");
  }
  const counts = requestCounts();
  log("  전체 요청 누적: briefing=" + counts.briefing + ", page=" + counts.page +
    ", extraction=" + counts.extraction + ", 기타=" + counts.other);
  log("  H1 판정: 사실 블록 동등성 + 전체 본문의 거절/미결정 ID·전문 + F6 마커(NFC) + " +
    "확정 밖 후보 전문 + 교정 피드백 화이트리스트(종류+위치)");
  printCheckViolations(check2Violations);
  log("");

  const check3Violations = violationsFor(3);
  printCheckHeader("검사 3 — 정정 무결성 (앱 관찰 인터페이스만, versionStore 없음)", check3Violations);
  log("  결정론 층 — 무효화 연쇄 (core + 실제 UI 핸들러)");
  for (const check of invalidation.checks) {
    log("    " + (check.ok ? "ok  " : "FAIL") + " " + check.name +
      (!check.ok && check.detail ? " — " + check.detail : ""));
  }
  if (correction) {
    log("  정정 경로 (실제 앱 UI: 메모 수정 → 사진 변경 → 추출 → 결정 → 재확정)");
    log("    추출 응답에 구 F10 ID 재사용 주입: " +
      (correction.extractionRaw.candidates.some((c) => c.id === "F10" &&
        nfc(c.text) === nfc(correction.correctedText)) ? "예 (선제 보정 없음)" : "아니오"));
    for (const check of correction.checks) {
      log("    " + (check.ok ? "ok  " : "FAIL") + " " + check.name +
        (!check.ok && check.detail ? " — " + check.detail : ""));
    }
    if (relation) {
      log("  현재 레코드 관계 단언");
      for (const check of relation.checks) {
        log("    " + (check.ok ? "ok  " : "FAIL") + " " + check.name +
          (!check.ok && check.detail ? " — " + check.detail : ""));
      }
      log("    최종 정정 사실 ID: " + (relation.finalId || "?") +
        " (구 F10 재사용: " + (relation.finalId === "F10" ? "예 — FAIL 사유" : "아니오") + ")");
    }
  } else {
    log("    (정정 경로 실행 결과 없음)");
  }
  if (guard) {
    log("  재진입 입구 가드 + v2 라이브 재합성");
    log("    프리뷰 가드: " + JSON.stringify(guard.guardPreview));
    log("    취침 가드: " + JSON.stringify(guard.guardPage));
    if (!guard.skipped && guard.finalRecord) {
      const page = Array.isArray(guard.finalRecord.pageSentences)
        ? guard.finalRecord.pageSentences : [];
      const related = page.filter((sentence) =>
        sentence && Array.isArray(sentence.factIds) &&
        sentence.factIds.includes(guard.finalId));
      log("    v2 정정 사실 인용 문장: " + related.length + "건 (finalId=" +
        (guard.finalId || "?") + ")");
      if (related.length === 0) {
        log("    H4 토큰 스캔 대상 없음 — 검사 3 인용 단언에서 이미 FAIL");
      } else {
        log("    H4 토큰 스캔: " + related.length + "문장, 토큰 " +
          OLD_VALUE_TOKENS.map((t) => "\"" + t.token + "\"").join(", ") +
          " — 토큰 수준 가드이며 의미 검사가 아니다");
      }
    }
  } else {
    log("    (v2 재진입 실행 결과 없음)");
  }
  log("  버전 인터페이스 한계: 앱은 현재 레코드 1개만 저장하며 페이지 버전 식별자/이력이 없다.");
  log("    따라서 '두 버전 동시 조회'와 'v1 바이트 불변'은 앱 인터페이스로 단언할 수 없어 제외했다.");
  const v1LedgerHash = TawCore.serialize(v1Composed) !== null
    ? sha256Hex(TawCore.serialize(v1Composed))
    : "(직렬화 불가)";
  log("  하니스 장부: 정정 전 레코드 스냅샷 sha256=" + v1LedgerHash +
    " — 앱 버전 ID 아님, 단언에 사용하지 않음");
  log("  하니스 장부: fixture sha256=" + fixtureHashBefore + " — fixture 무결성 증거");
  printCheckViolations(check3Violations);
  log("");

  // -------------------------------------------------------------------------
  // Core regression
  // -------------------------------------------------------------------------
  const coreRun = spawnSync(process.execPath, [CORE_TEST_PATH], {
    cwd: ROOT,
    encoding: "utf8"
  });
  const coreOut = (coreRun.stdout || "") + (coreRun.stderr || "");
  const coreMatch = coreOut.match(/(\d+) passed, (\d+) failed/);
  const corePassed = coreMatch ? Number(coreMatch[1]) : -1;
  const coreFailed = coreMatch ? Number(coreMatch[2]) : -1;
  const coreOk = coreRun.status === 0 && coreFailed === 0 && corePassed >= 38;
  log("[회귀] " + (coreOk ? "PASS" : "FAIL") +
    " — core 테스트 전체 통과 (기존 38개 이상, 신규 테스트 허용)");
  log("  " + (coreMatch ? coreMatch[0] : "결과 파싱 실패") + " (exit " + coreRun.status + ")");
  if (!coreOk) {
    log("  --- core test output ---");
    log(coreOut.trim());
  }
  log("");

  // -------------------------------------------------------------------------
  // Fixture integrity
  // -------------------------------------------------------------------------
  const fixtureHashAfter = sha256Hex(fs.readFileSync(FIXTURE_PATH));
  ledger.fixtureHashAfter = fixtureHashAfter;
  const fixtureOk = fixtureHashAfter === fixtureHashBefore;
  log("[무결성] " + (fixtureOk ? "PASS" : "FAIL") +
    " — fixtures/deuri-day.json 무변경 [하니스 장부]");
  log("  before=" + fixtureHashBefore);
  log("  after =" + fixtureHashAfter);
  log("");

  // H6: the full append-only ledger summary. Incidents include recoverable model
  // contract failures (the app retried/used its fallback); they are reported but
  // are not served-sentence violations. Notes record deliberate recovery steps.
  log("[H6 누적 장부] 세션별 요청/출력");
  for (const session of ledger.sessions) {
    log("  - " + session.label + ": 요청 " + session.requests.length +
      ", 출력 " + session.outputs.length +
      (session.live ? " (live)" : "") + (session.probe ? " (probe)" : ""));
  }
  log("  누적 사건(incident): " + ledger.incidents.length + "건");
  for (const incident of ledger.incidents) {
    log("    - " + new Date(incident.at).toISOString() + " [" + (incident.session || "?") +
      "]: " + incident.message);
  }
  log("  누적 메모(note): " + ledger.notes.length + "건");
  for (const note of ledger.notes) log("    - " + note);
  log("  H6: 요청·출력·위반은 시도/세션 단위로 append-only 누적 — 이후 성공이 이전 위반을 지우지 않는다.");
  log("");

  const liveRequests = ledger.requests.filter((request) =>
    (request.session === "live v1 (검사 1+2)" ||
      request.session === "검사 3 v2 재진입 + 라이브")).length;
  const liveLayerIncluded = !!(liveV1 && liveV1.app.session.requests.length > 0 &&
    guard && !guard.skipped && guard.app.session.requests.length > 0);
  const allOk = check1Violations.length === 0 && check2Violations.length === 0 &&
    check3Violations.length === 0 && coreOk && fixtureOk;
  log("RESULT: " + (allOk ? "PASS" : "FAIL") +
    " — 검사 " + [check1Violations.length === 0, check2Violations.length === 0,
      check3Violations.length === 0].filter(Boolean).length + "/3 PASS" +
    ", core " + (coreOk ? corePassed + " passed" : "FAIL") +
    ", fixture " + (fixtureOk ? "unchanged" : "CHANGED") +
    ", live layer " + (liveLayerIncluded ? "included (" + liveRequests + " requests)" : "incomplete") +
    ", 누적 세션 " + ledger.sessions.length + " / 요청 " + ledger.requests.length +
    " / 출력 " + ledger.outputs.length);
  log("H6: 위반은 append-only로 누적되었다 — 이후 성공이 이전 위반을 지우지 않는다.");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[S7] harness crashed: " + (err && err.stack ? err.stack : err));
  process.exit(1);
});
