// Tuck & Whisper — 데이터 계약 층 (S1a)
// 브리프 v2(build-brief-core-path-v2.md)의 데이터 계약이 이 파일의 유일한 기준이다.
// DOM·fetch·localStorage 접근은 여기 없다 — 화면/API 층이 가져다 쓰는 순수 함수만 있다.
//
// 브라우저:    <script src="core.js"></script> 를 읽은 뒤 전역 TawCore 로 사용한다.
// Node/테스트: import TawCore from "../web/core.js";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api; // Node — require 와 ESM default import 모두 이 값을 받는다.
  } else {
    root.TawCore = api; // 브라우저 전역
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 브리프: localStorage 저장은 taw-day-v1 키 하나뿐이다. (실제 읽기/쓰기는 화면 층의 몫)
  const STORAGE_KEY = "taw-day-v1";

  // 계약이 허용하는 값들 — 이 목록 밖이면 깨진 데이터다.
  const MODES = ["sample", "live"];
  const SOURCES = ["photo", "memo"];
  const GRADES = ["B", "C"];
  const DECISIONS = ["undecided", "confirmed", "rejected"];

  function isFilledString(value) {
    return typeof value === "string" && value.trim() !== "";
  }

  // -------------------------------------------------------------------
  // 1. DayRecord 생성
  // -------------------------------------------------------------------

  // 빈 DayRecord — 데이터 계약 그대로 5개 필드만 있다.
  function createDayRecord() {
    return {
      mode: "live", // 빈 레코드는 Capture 화면의 라이브 하루에서 시작한다.
      memoText: "",
      candidates: [],
      unknowns: [],
      gate1Complete: false
    };
  }

  // -------------------------------------------------------------------
  // 2. 정규화
  // -------------------------------------------------------------------

  // Spark 원시 출력(JSON 파싱 "직후"의 객체)을 계약 형식으로 정규화한다.
  // 코드펜스 제거와 JSON.parse 는 API 층의 몫이고, 여기는 파싱된 객체만 받는다.
  //
  // - 후보: id가 없으면 F1… 순으로 부여, 이미 있으면(샘플 데이터) 그 id를 유지.
  // - unknowns: 문자열이면 {id, text}로 감싸 U1… 부여, 이미 {id, text}면 유지.
  // - 모든 후보 decision은 "undecided"로 시작한다.
  // - source/grade가 계약 밖이거나 형식이 깨진 것은 확정 가능 후보로 만들지 않고
  //   debug 배열로 분리해 반환한다 (원형 entry 와 이유를 함께 담는다).
  //
  // 반환: { candidates, unknowns, debug } — DayRecord 에 넣기 전 단계의 조각.
  function normalizeSpark(raw) {
    const result = { candidates: [], unknowns: [], debug: [] };
    if (!raw || typeof raw !== "object") return result;

    const rawCandidates = Array.isArray(raw.candidates) ? raw.candidates : [];
    const rawUnknowns = Array.isArray(raw.unknowns) ? raw.unknowns : [];

    let factCount = 0;
    for (const entry of rawCandidates) {
      if (!entry || typeof entry !== "object") {
        result.debug.push({ kind: "candidate", reason: "객체가 아님", entry: entry });
        continue;
      }
      if (!isFilledString(entry.text)) {
        result.debug.push({ kind: "candidate", reason: "text가 비어 있음", entry: entry });
        continue;
      }
      if (SOURCES.indexOf(entry.source) === -1 || GRADES.indexOf(entry.grade) === -1) {
        result.debug.push({ kind: "candidate", reason: "source/grade가 계약 밖", entry: entry });
        continue;
      }
      factCount += 1;
      result.candidates.push({
        id: isFilledString(entry.id) ? entry.id : "F" + factCount,
        text: entry.text,
        source: entry.source,
        grade: entry.grade,
        decision: "undecided"
      });
    }

    let unknownCount = 0;
    for (const entry of rawUnknowns) {
      if (typeof entry === "string" && entry.trim() !== "") {
        unknownCount += 1;
        result.unknowns.push({ id: "U" + unknownCount, text: entry });
      } else if (entry && typeof entry === "object" && isFilledString(entry.text)) {
        // 샘플 데이터처럼 이미 감싸진 unknown — id가 있으면 그대로 유지한다.
        unknownCount += 1;
        result.unknowns.push({
          id: isFilledString(entry.id) ? entry.id : "U" + unknownCount,
          text: entry.text
        });
      } else {
        result.debug.push({ kind: "unknown", reason: "unknown 형식이 계약 밖", entry: entry });
      }
    }

    return result;
  }

  // -------------------------------------------------------------------
  // 3. 파생 — 확정 사실과 Gate 1 완료는 저장하지 않고 매번 계산한다.
  // -------------------------------------------------------------------

  // Gate 1 완료: 후보가 1개 이상이고 undecided가 0개일 때만 true.
  // 후보 0개는 완료가 아니다. unknowns는 완료 카운트에 넣지 않는다.
  function gate1Complete(record) {
    if (!record || !Array.isArray(record.candidates)) return false;
    return (
      record.candidates.length > 0 &&
      record.candidates.every(function (c) {
        return c && c.decision !== "undecided";
      })
    );
  }

  // DayRecord 계약의 gate1Complete 필드를 후보에서 다시 계산한 사본으로 갱신한다.
  // 이 모듈의 상태 전이 함수는 전부 이걸 거치므로 필드가 항상 유도값과 일치한다.
  // (참고: 이 함수가 유일한 기준이다 — 저장된 필드값을 믿는 곳은 없다.)
  function withDerivedState(record) {
    return Object.assign({}, record, { gate1Complete: gate1Complete(record) });
  }

  // 확정 사실 = decision === "confirmed" 필터 결과. 별도 배열에 저장하지 않는다.
  // 후보 객체의 사본을 담은 새 배열을 반환하므로 파생 결과가 원본을 오염시킬 수 없다.
  function confirmedFacts(record) {
    if (!record || !Array.isArray(record.candidates)) return [];
    return record.candidates
      .filter(function (c) {
        return c && c.decision === "confirmed";
      })
      .map(function (c) {
        return Object.assign({}, c);
      });
  }

  // -------------------------------------------------------------------
  // 4. 상태 전이 — 전부 불변: 입력 record를 수정하지 않고 새 record를 반환한다.
  // -------------------------------------------------------------------

  // 결정 변경. decision이 계약 밖이거나 후보 id를 못 찾으면 던진다 —
  // 데이터 계약 위반은 조용히 무시하지 않는다.
  function setDecision(record, candidateId, decision) {
    if (DECISIONS.indexOf(decision) === -1) {
      throw new TypeError("decision은 undecided|confirmed|rejected 중 하나여야 한다: " + decision);
    }
    if (!record || !Array.isArray(record.candidates)) {
      throw new TypeError("record가 DayRecord 형식이 아니다");
    }
    let found = false;
    const candidates = record.candidates.map(function (c) {
      if (c && c.id === candidateId) {
        found = true;
        return Object.assign({}, c, { decision: decision });
      }
      return c;
    });
    if (!found) {
      throw new Error("후보를 찾을 수 없다: " + candidateId);
    }
    return withDerivedState(Object.assign({}, record, { candidates: candidates }));
  }

  // 무효화 규칙: 사진/메모가 바뀌었으면 후보·결정·unknowns를 전부 비운다.
  // mode와 memoText는 그대로 둔다 (새 메모 텍스트를 넣는 것은 화면 층의 몫).
  function invalidateExtraction(record) {
    if (!record || typeof record !== "object") {
      throw new TypeError("record가 객체가 아니다");
    }
    return withDerivedState(
      Object.assign({}, record, { candidates: [], unknowns: [] })
    );
  }

  // -------------------------------------------------------------------
  // 5. 저장/복원 — 정규화된 텍스트 데이터와 결정만. 사진·오디오·base64 금지.
  // -------------------------------------------------------------------

  // 저장 형식 검증 + 화이트리스트 복사. 계약에서 벗어난 게 하나라도 있으면 null.
  // gate1Complete 는 저장값을 믿지 않고 후보에서 다시 계산한다.
  function parseStored(data) {
    if (!data || typeof data !== "object") return null;
    if (MODES.indexOf(data.mode) === -1) return null;
    if (typeof data.memoText !== "string") return null;
    if (!Array.isArray(data.candidates) || !Array.isArray(data.unknowns)) return null;

    const candidates = [];
    for (const c of data.candidates) {
      if (!c || typeof c !== "object") return null;
      if (!isFilledString(c.id) || !isFilledString(c.text)) return null;
      if (SOURCES.indexOf(c.source) === -1 || GRADES.indexOf(c.grade) === -1) return null;
      if (DECISIONS.indexOf(c.decision) === -1) return null;
      candidates.push({
        id: c.id,
        text: c.text,
        source: c.source,
        grade: c.grade,
        decision: c.decision
      });
    }

    const unknowns = [];
    for (const u of data.unknowns) {
      if (!u || typeof u !== "object") return null;
      if (!isFilledString(u.id) || !isFilledString(u.text)) return null;
      unknowns.push({ id: u.id, text: u.text });
    }

    return withDerivedState({
      mode: data.mode,
      memoText: data.memoText,
      candidates: candidates,
      unknowns: unknowns
    });
  }

  // JSON 문자열로 직렬화. 레코드가 계약에 맞지 않으면 null (저장하지 않는다).
  // 화이트리스트만 남기므로 레코드에 잘못 붙은 사진/base64 등은 저장에 닿지 않는다.
  function serialize(record) {
    const clean = parseStored(record);
    if (!clean) return null;
    return JSON.stringify({
      mode: clean.mode,
      memoText: clean.memoText,
      candidates: clean.candidates,
      unknowns: clean.unknowns,
      gate1Complete: clean.gate1Complete
    });
  }

  // JSON 문자열(또는 이미 파싱된 객체)을 검증해서 DayRecord로 되돌린다.
  // 깨진 JSON이거나 형태가 계약에서 벗어났으면 null.
  function restore(json) {
    let data = json;
    if (typeof json === "string") {
      try {
        data = JSON.parse(json);
      } catch (err) {
        return null;
      }
    }
    return parseStored(data);
  }

  // -------------------------------------------------------------------
  // 6. 추출 토큰 가드 — 늦게 도착한 이전 응답이 새 상태를 덮지 못하게 한다.
  // -------------------------------------------------------------------

  // 모듈 일련번호: beginExtraction 을 마지막으로 호출했을 때 발급된 토큰만 "최신"이다.
  // (이 카운터가 모듈에서 유일한 상태다. DOM·네트워크·저장소 접근은 없다.)
  let extractionSeq = 0;

  // 추출 시작 — 이 record 에 묶인 토큰을 발급한다.
  function beginExtraction(record) {
    if (!record || typeof record !== "object") {
      throw new TypeError("record가 객체가 아니다");
    }
    extractionSeq += 1;
    return { seq: extractionSeq, record: record };
  }

  // 토큰이 최신이고 이 record 에 발급된 것일 때만 raw 를 적용한다.
  // 그 외에는 입력 record 를 그대로 돌려준다 (아무 일도 일어나지 않았다).
  // raw 는 candidates 배열이 있는 파싱된 객체여야 한다 — 구조가 깨진 raw 로
  // 기존 상태를 빈 상태로 덮는 사고를 막는다 (정상적인 빈 결과는 적용된다).
  function applyExtraction(record, token, raw) {
    const applicable =
      record &&
      typeof record === "object" &&
      token &&
      typeof token === "object" &&
      token.seq === extractionSeq &&
      token.record === record &&
      raw &&
      typeof raw === "object" &&
      Array.isArray(raw.candidates);
    if (!applicable) return record;

    const normalized = normalizeSpark(raw);
    return withDerivedState(
      Object.assign({}, record, {
        candidates: normalized.candidates,
        unknowns: normalized.unknowns
      })
    );
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    createDayRecord: createDayRecord,
    normalizeSpark: normalizeSpark,
    setDecision: setDecision,
    confirmedFacts: confirmedFacts,
    gate1Complete: gate1Complete,
    invalidateExtraction: invalidateExtraction,
    serialize: serialize,
    restore: restore,
    beginExtraction: beginExtraction,
    applyExtraction: applyExtraction
  };
});
