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

  // 같은 id가 두 번 이상 나오면 true — 깨진 데이터다.
  function hasDuplicateId(items) {
    const seen = new Set();
    for (const item of items) {
      if (seen.has(item.id)) return true;
      seen.add(item.id);
    }
    return false;
  }

  // 전부 문자열인 배열인지 (S4 확장 필드 검증용 — 빈 문자열도 계약상 문자열이다).
  function isStringArray(value) {
    return Array.isArray(value) && value.every(function (v) {
      return typeof v === "string";
    });
  }

  // -------------------------------------------------------------------
  // 1. DayRecord 생성
  // -------------------------------------------------------------------

  // 빈 DayRecord — 데이터 계약 그대로다. S4 확장: 브리핑·질문 카드·페이지 문장·증언.
  // briefing/questionCard/pageSentences는 사실이 바뀌면 초기값으로 되돌아간다(연쇄 무효화),
  // testimony는 아이 대답 기록이라 사실 정정과 무관하게 유지된다.
  function createDayRecord() {
    return {
      mode: "live", // 빈 레코드는 Capture 화면의 라이브 하루에서 시작한다.
      memoText: "",
      candidates: [],
      unknowns: [],
      gate1Complete: false,
      briefing: null, // null 또는 [{text, factIds[]}]
      questionCard: null, // null 또는 {text, unknownId, premiseFactIds[]}
      pageSentences: [], // [{text, factIds[]}] — 채우는 것은 S5
      testimony: [] // [{text, at}] — 입력 UI는 S5
    };
  }

  // -------------------------------------------------------------------
  // 2. 정규화
  // -------------------------------------------------------------------

  // Spark 원시 출력(JSON 파싱 "직후"의 객체)을 계약 형식으로 정규화한다.
  // 코드펜스 제거와 JSON.parse 는 API 층의 몫이고, 여기는 파싱된 객체만 받는다.
  //
  // - 후보: id가 없으면 F1… 순으로 부여, 이미 있으면(샘플 데이터) 그 id를 유지 —
  //   단, 그 ID가 유일할 때만이다. 중복 명시 ID는 두 번째 등장부터 debug로 격리하고
  //   자동 ID는 명시 ID·이미 발급한 ID와 절대 겹치지 않게 발급한다 (P0: ID 유일성).
  // - unknowns: 문자열이면 {id, text}로 감싸 U1… 부여, 이미 {id, text}면 유지 —
  //   후보와 같은 ID 유일성 규칙을 적용한다.
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

    // 0차: 명시 ID를 먼저 수집한다 — 자동 ID는 이 집합과 겹치지 않게 발급한다.
    // (형식 검증에 걸려 debug로 격리될 항목의 ID도 예약에 포함한다.)
    const explicitFactIds = new Set();
    for (const entry of rawCandidates) {
      if (entry && typeof entry === "object" && isFilledString(entry.id)) {
        explicitFactIds.add(entry.id);
      }
    }
    const explicitUnknownIds = new Set();
    for (const entry of rawUnknowns) {
      if (entry && typeof entry === "object" && isFilledString(entry.id)) {
        explicitUnknownIds.add(entry.id);
      }
    }

    // 1차: 형식 검증 + 명시 ID 중복 격리 (입력 순서대로).
    // 명시 ID는 유일할 때만 보존된다 — 두 번째 등장부터는 확정 가능 후보가 아니다.
    const acceptedCandidates = [];
    const claimedFactIds = new Set();
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
      if (isFilledString(entry.id)) {
        if (claimedFactIds.has(entry.id)) {
          result.debug.push({ kind: "candidate", reason: "ID가 중복됨", entry: entry });
          continue;
        }
        claimedFactIds.add(entry.id);
        acceptedCandidates.push({
          id: entry.id,
          text: entry.text,
          source: entry.source,
          grade: entry.grade,
          decision: "undecided"
        });
      } else {
        acceptedCandidates.push({
          id: null, // 2차에서 자동 발급
          text: entry.text,
          source: entry.source,
          grade: entry.grade,
          decision: "undecided"
        });
      }
    }

    // 2차: 자동 ID 발급 — 명시 ID(전체)와 이미 발급한 ID를 피해 F1… 순으로.
    let factSeq = 0;
    for (const c of acceptedCandidates) {
      if (c.id === null) {
        do {
          factSeq += 1;
          c.id = "F" + factSeq;
        } while (explicitFactIds.has(c.id) || claimedFactIds.has(c.id));
        claimedFactIds.add(c.id);
      }
      result.candidates.push(c);
    }

    // unknowns 도 같은 규칙: 문자열 감싸기 + 명시 ID 유일성 + 자동 ID 충돌 회피.
    const acceptedUnknowns = [];
    const claimedUnknownIds = new Set();
    for (const entry of rawUnknowns) {
      if (typeof entry === "string" && entry.trim() !== "") {
        acceptedUnknowns.push({ id: null, text: entry });
      } else if (entry && typeof entry === "object" && isFilledString(entry.text)) {
        if (isFilledString(entry.id)) {
          if (claimedUnknownIds.has(entry.id)) {
            result.debug.push({ kind: "unknown", reason: "ID가 중복됨", entry: entry });
            continue;
          }
          claimedUnknownIds.add(entry.id);
          acceptedUnknowns.push({ id: entry.id, text: entry.text });
        } else {
          acceptedUnknowns.push({ id: null, text: entry.text });
        }
      } else {
        result.debug.push({ kind: "unknown", reason: "unknown 형식이 계약 밖", entry: entry });
      }
    }
    let unknownSeq = 0;
    for (const u of acceptedUnknowns) {
      if (u.id === null) {
        do {
          unknownSeq += 1;
          u.id = "U" + unknownSeq;
        } while (explicitUnknownIds.has(u.id) || claimedUnknownIds.has(u.id));
        claimedUnknownIds.add(u.id);
      }
      result.unknowns.push(u);
    }

    return result;
  }

  // -------------------------------------------------------------------
  // 3. 파생 — 확정 사실과 Gate 1 완료는 저장하지 않고 매번 계산한다.
  // -------------------------------------------------------------------

  // Gate 1 완료: 후보가 1개 이상이고 모든 후보가 허용된 결정값을 가질 때만 true.
  // 허용값 = "confirmed" | "rejected" (allowlist 검사). undecided는 물론이고
  // 계약 밖 decision 값도 결정으로 인정하지 않는다 — "undecided만 아니면 됨"이 아니다.
  // 후보 0개는 완료가 아니다. unknowns는 완료 카운트에 넣지 않는다.
  function gate1Complete(record) {
    if (!record || !Array.isArray(record.candidates)) return false;
    return (
      record.candidates.length > 0 &&
      record.candidates.every(function (c) {
        return !!c && (c.decision === "confirmed" || c.decision === "rejected");
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

  // 합성 경계 (S4): 합성 payload는 이 반환값으로만 만든다 —
  // 화면 층이 record.candidates를 직접 읽어 합성 입력을 만드는 것은 금지다.
  function synthesisFacts(record) {
    return confirmedFacts(record);
  }

  // 합성 결과 검사: 모든 문장이 factIds를 1개 이상 인용하고, 인용이 전부
  // 확정 집합 안에 있어야 한다. confirmedIds는 문자열 배열(또는 Set)이다.
  function validateComposition(sentences, confirmedIds) {
    const allowed = new Set(confirmedIds);
    const violations = [];
    if (!Array.isArray(sentences)) {
      violations.push({ index: -1, text: "", reason: "문장 배열이 아니다" });
      return { ok: false, violations: violations };
    }
    sentences.forEach(function (sentence, index) {
      if (!sentence || typeof sentence !== "object" || !isFilledString(sentence.text)) {
        violations.push({ index: index, text: "", reason: "형식이 깨진 문장이다" });
        return;
      }
      if (!Array.isArray(sentence.factIds) || sentence.factIds.length === 0) {
        violations.push({ index: index, text: sentence.text, reason: "인용한 factIds가 없다" });
        return;
      }
      const notAllowed = sentence.factIds.filter(function (id) {
        return !allowed.has(id);
      });
      if (notAllowed.length > 0) {
        violations.push({
          index: index,
          text: sentence.text,
          reason: "확정되지 않은 사실을 인용했다: " + notAllowed.join(", ")
        });
      }
    });
    return { ok: violations.length === 0, violations: violations };
  }

  // LEAK 검사 금지 어휘 (S5 — 동결): 감정·인과·서사를 암시하는 표현.
  // 아이에게 읽어 줄 문장이 확정 사실 원문에 없는 이런 말로 흐르는 것을 막는다.
  const LEAK_WORDS = [
    "신나", "즐거", "행복", "슬프", "슬퍼", "무서", "때문에", "그래서",
    "친구", "함께", "놀랐", "놀라", "기쁘", "울었", "울며", "사랑"
  ];

  // LEAK 검사 (결정적 — 모델 호출 없음): 문장에 금지 어휘가 있는데, 그 문장이 인용한
  // 사실들의 원문 어디에도 없으면 위반. factsById는 id → 사실 객체({text}) 또는
  // id → 원문 문자열 둘 다 받는다. 반환은 validateComposition과 같은 모양이다.
  function checkLeaks(sentences, factsById) {
    const violations = [];
    if (!Array.isArray(sentences)) {
      violations.push({ index: -1, text: "", reason: "문장 배열이 아니다" });
      return { ok: false, violations: violations };
    }
    sentences.forEach(function (sentence, index) {
      if (!sentence || typeof sentence !== "object" || typeof sentence.text !== "string") {
        violations.push({ index: index, text: "", reason: "형식이 깨진 문장이다" });
        return;
      }
      const cited = Array.isArray(sentence.factIds) ? sentence.factIds : [];
      let originalTexts = "";
      for (const id of cited) {
        const fact = factsById ? factsById[id] : null;
        if (typeof fact === "string") originalTexts += fact + "\n";
        else if (fact && typeof fact === "object" && typeof fact.text === "string") originalTexts += fact.text + "\n";
      }
      const leaked = LEAK_WORDS.filter(function (word) {
        return sentence.text.indexOf(word) !== -1 && originalTexts.indexOf(word) === -1;
      });
      if (leaked.length > 0) {
        violations.push({
          index: index,
          text: sentence.text,
          reason: "원문에 없는 표현이 들어갔다: " + leaked.join(", ")
        });
      }
    });
    return { ok: violations.length === 0, violations: violations };
  }

  // -------------------------------------------------------------------
  // 4. 상태 전이 — 전부 불변: 입력 record를 수정하지 않고 새 record를 반환한다.
  // -------------------------------------------------------------------

  // 결정 변경. decision이 계약 밖이거나 후보 id가 정확히 하나에 일치하지 않으면
  // (0개 또는 2개 이상) 던진다 — 데이터 계약 위반은 조용히 무시하지 않는다.
  function setDecision(record, candidateId, decision) {
    if (DECISIONS.indexOf(decision) === -1) {
      throw new TypeError("decision은 undecided|confirmed|rejected 중 하나여야 한다: " + decision);
    }
    if (!record || !Array.isArray(record.candidates)) {
      throw new TypeError("record가 DayRecord 형식이 아니다");
    }
    let matchCount = 0;
    const candidates = record.candidates.map(function (c) {
      if (c && c.id === candidateId) {
        matchCount += 1;
        return Object.assign({}, c, { decision: decision });
      }
      return c;
    });
    if (matchCount !== 1) {
      // 정확히 하나만 바꿔야 한다 — 0개면 없는 id, 2개 이상이면 깨진 레코드다.
      if (matchCount === 0) {
        throw new Error("후보를 찾을 수 없다: " + candidateId);
      }
      throw new Error(
        "후보 id가 정확히 하나가 아니다: " + candidateId + " (" + matchCount + "개)"
      );
    }
    // 연쇄 무효화 (Argon 규정): 결정이 바뀌면 합성물(briefing/questionCard/pageSentences)은
    // 전부 초기값으로 되돌린다. testimony는 사실 정정과 무관하고 사실로 승격되는
    // 경로가 없어 유지한다.
    return withDerivedState(
      Object.assign({}, record, {
        candidates: candidates,
        briefing: null,
        questionCard: null,
        pageSentences: []
      })
    );
  }

  // 무효화 규칙: 사진/메모가 바뀌었으면 후보·결정·unknowns를 전부 비운다.
  // 연쇄 무효화: 합성물(briefing/questionCard/pageSentences)도 초기값으로 되돌린다.
  // testimony는 유지한다 (아이 대답 기록 — 사실 정정과 무관).
  // mode와 memoText는 그대로 둔다 (새 메모 텍스트를 넣는 것은 화면 층의 몫).
  function invalidateExtraction(record) {
    if (!record || typeof record !== "object") {
      throw new TypeError("record가 객체가 아니다");
    }
    return withDerivedState(
      Object.assign({}, record, {
        candidates: [],
        unknowns: [],
        briefing: null,
        questionCard: null,
        pageSentences: []
      })
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

    // ID 중복은 깨진 저장 데이터다 — 복원하지 않는다.
    if (hasDuplicateId(candidates) || hasDuplicateId(unknowns)) return null;

    // S4 확장 필드 — 없으면(옛 5필드 저장본) 기본값으로 채워 복원한다(하위호환).
    // 있으면 형식을 검증한다: text는 비어 있지 않은 문자열, factIds/premiseFactIds는
    // 문자열 배열, unknownId는 문자열, at은 숫자. 하나라도 벗어나면 전체 null.
    let briefing = null;
    if (data.briefing !== undefined && data.briefing !== null) {
      if (!Array.isArray(data.briefing)) return null;
      briefing = [];
      for (const line of data.briefing) {
        if (!line || typeof line !== "object" || !isFilledString(line.text) || !isStringArray(line.factIds)) {
          return null;
        }
        briefing.push({ text: line.text, factIds: line.factIds });
      }
    }

    let questionCard = null;
    if (data.questionCard !== undefined && data.questionCard !== null) {
      if (!data.questionCard || typeof data.questionCard !== "object") return null;
      if (typeof data.questionCard.text !== "string" || typeof data.questionCard.unknownId !== "string" ||
          !isStringArray(data.questionCard.premiseFactIds)) {
        return null;
      }
      if (!isFilledString(data.questionCard.text)) return null;
      questionCard = {
        text: data.questionCard.text,
        unknownId: data.questionCard.unknownId,
        premiseFactIds: data.questionCard.premiseFactIds
      };
    }

    let pageSentences = [];
    if (data.pageSentences !== undefined && data.pageSentences !== null) {
      if (!Array.isArray(data.pageSentences)) return null;
      pageSentences = [];
      for (const sentence of data.pageSentences) {
        if (!sentence || typeof sentence !== "object" || !isFilledString(sentence.text) || !isStringArray(sentence.factIds)) {
          return null;
        }
        pageSentences.push({ text: sentence.text, factIds: sentence.factIds });
      }
    }

    let testimony = [];
    if (data.testimony !== undefined && data.testimony !== null) {
      if (!Array.isArray(data.testimony)) return null;
      testimony = [];
      for (const entry of data.testimony) {
        if (!entry || typeof entry !== "object" || !isFilledString(entry.text) || typeof entry.at !== "number") {
          return null;
        }
        testimony.push({ text: entry.text, at: entry.at });
      }
    }

    return withDerivedState({
      mode: data.mode,
      memoText: data.memoText,
      candidates: candidates,
      unknowns: unknowns,
      briefing: briefing,
      questionCard: questionCard,
      pageSentences: pageSentences,
      testimony: testimony
    });
  }

  // JSON 문자열로 직렬화. 레코드가 계약에 맞지 않으면 null (저장하지 않는다).
  // 화이트리스트만 남기므로 레코드에 잘못 붙은 사진/base64 등은 저장에 닿지 않는다.
  // S4: 확장 4필드(briefing/questionCard/pageSentences/testimony) 포함 — 총 9필드.
  function serialize(record) {
    const clean = parseStored(record);
    if (!clean) return null;
    return JSON.stringify({
      mode: clean.mode,
      memoText: clean.memoText,
      candidates: clean.candidates,
      unknowns: clean.unknowns,
      gate1Complete: clean.gate1Complete,
      briefing: clean.briefing,
      questionCard: clean.questionCard,
      pageSentences: clean.pageSentences,
      testimony: clean.testimony
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
    synthesisFacts: synthesisFacts,
    validateComposition: validateComposition,
    checkLeaks: checkLeaks,
    gate1Complete: gate1Complete,
    invalidateExtraction: invalidateExtraction,
    serialize: serialize,
    restore: restore,
    beginExtraction: beginExtraction,
    applyExtraction: applyExtraction
  };
});
