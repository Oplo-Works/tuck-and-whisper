// S1a 단위 테스트 — 데이터 계약 층 (web/core.js)
// 실행: node tests/core.test.mjs  (Node 내장 assert만 사용, 외부 의존성 없음)
import assert from "node:assert/strict";
import TawCore from "../web/core.js";

const {
  STORAGE_KEY,
  createDayRecord,
  normalizeSpark,
  setDecision,
  confirmedFacts,
  synthesisFacts,
  validateComposition,
  checkLeaks,
  gate1Complete,
  invalidateExtraction,
  serialize,
  restore,
  beginExtraction,
  applyExtraction
} = TawCore;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok    " + name);
  } catch (err) {
    failures.push(name);
    console.log("  FAIL  " + name);
    console.log("        " + (err && err.message ? err.message : err));
  }
}

// 헬퍼 — raw Spark 출력을 새 레코드에 적용해 DayRecord를 만든다 (화면 층이 쓸 실제 경로).
function recordFromRaw(memoText, raw) {
  const base = Object.assign(createDayRecord(), { memoText: memoText });
  const token = beginExtraction(base);
  return applyExtraction(base, token, raw);
}

const SPARK_TWO = {
  candidates: [
    { text: "아이가 풀밭 길 위에 서 있다", source: "photo", grade: "C" },
    { text: "밭길에서 놀았다", source: "memo", grade: "B" }
  ],
  unknowns: ["강아지의 견종은 무엇인가?", "사진에서 아이의 기분은 확인되는가?"]
};

// ---------------------------------------------------------------------
console.log("normalize");
// ---------------------------------------------------------------------

test("createDayRecord는 계약 그대로의 빈 DayRecord를 반환한다 (S4 확장 필드 포함)", () => {
  assert.deepEqual(createDayRecord(), {
    mode: "live",
    memoText: "",
    candidates: [],
    unknowns: [],
    gate1Complete: false,
    briefing: null,
    questionCard: null,
    pageSentences: [],
    testimony: []
  });
});

test("문자열 unknown이 {id, text}로 감싸지고 U1… 순서로 id가 붙는다", () => {
  const out = normalizeSpark({ candidates: [], unknowns: ["견종은?", "성별은?"] });
  assert.deepEqual(out.unknowns, [
    { id: "U1", text: "견종은?" },
    { id: "U2", text: "성별은?" }
  ]);
});

test("후보에 F1… 순서로 id가 붙고 decision은 전부 undecided로 시작한다", () => {
  const out = normalizeSpark(SPARK_TWO);
  assert.deepEqual(out.candidates.map((c) => c.id), ["F1", "F2"]);
  assert.deepEqual(
    out.candidates.map((c) => c.decision),
    ["undecided", "undecided"]
  );
  // 후보 객체는 계약의 5개 필드만 가진다
  assert.deepEqual(Object.keys(out.candidates[0]).sort(), [
    "decision",
    "grade",
    "id",
    "source",
    "text"
  ]);
});

test("source/grade가 계약 밖이거나 깨진 후보는 debug로 분리되고 확정 가능 후보가 아니다", () => {
  const out = normalizeSpark({
    candidates: [
      { text: "정상 후보", source: "photo", grade: "C" },
      { text: "source가 계약 밖", source: "video", grade: "C" },
      { text: "grade가 계약 밖", source: "memo", grade: "A" },
      { text: "", source: "memo", grade: "C" },
      "아예 문자열"
    ],
    unknowns: []
  });
  assert.equal(out.candidates.length, 1);
  assert.equal(out.candidates[0].text, "정상 후보");
  assert.equal(out.candidates[0].id, "F1"); // 남은 후보 기준으로 순서 부여
  assert.equal(out.debug.length, 4);
  assert.equal(out.debug[0].entry.source, "video"); // 원형이 debug에 보존된다
});

test("이미 id가 있는 샘플 형태는 id를 유지하고 decision만 초기화한다 (샘플도 같은 정규화 경로)", () => {
  const out = normalizeSpark({
    candidates: [
      { id: "F11", text: "밭길에서 놀았다", source: "memo", grade: "B" },
      { id: "F12", text: "들이가 신유를 졸졸 따라다녔다", source: "memo", grade: "B" }
    ],
    unknowns: [{ id: "U1", text: "강아지의 견종은 무엇인가?" }]
  });
  assert.deepEqual(out.candidates.map((c) => c.id), ["F11", "F12"]);
  assert.deepEqual(out.unknowns, [{ id: "U1", text: "강아지의 견종은 무엇인가?" }]);
  assert.ok(out.candidates.every((c) => c.decision === "undecided"));
  assert.equal(out.debug.length, 0);
});

test("중복 명시 ID는 두 번째 등장부터 debug로 격리되고 정규화 결과에 남지 않는다 (unknowns도 동일)", () => {
  const out = normalizeSpark({
    candidates: [
      { id: "F1", text: "첫 번째 F1", source: "photo", grade: "C" },
      { id: "F1", text: "두 번째 F1", source: "memo", grade: "B" },
      { id: "F1", text: "세 번째 F1", source: "memo", grade: "C" }
    ],
    unknowns: [
      { id: "U1", text: "첫 번째 U1" },
      { id: "U1", text: "두 번째 U1" }
    ]
  });
  // 첫 번째만 살아 남고 나머지는 전부 격리된다
  assert.deepEqual(out.candidates.map((c) => c.id), ["F1"]);
  assert.equal(out.candidates[0].text, "첫 번째 F1");
  assert.deepEqual(out.unknowns.map((u) => u.id), ["U1"]);
  assert.equal(out.unknowns[0].text, "첫 번째 U1");
  // 격리 항목도 kind/reason/entry 형식을 유지한다
  assert.equal(out.debug.length, 3);
  assert.deepEqual(out.debug.map((d) => d.kind), ["candidate", "candidate", "unknown"]);
  assert.equal(out.debug[0].reason, "ID가 중복됨");
  assert.equal(out.debug[0].entry.text, "두 번째 F1");
  assert.equal(out.debug[2].reason, "ID가 중복됨");
  assert.equal(out.debug[2].entry.text, "두 번째 U1");
});

test("자동 ID는 기존 명시 ID와 절대 충돌하지 않는다 (입력 순서 무관)", () => {
  // 명시 F1 뒤에 오는 무 ID 후보는 F1을 피해 F2를 받는다
  const a = normalizeSpark({
    candidates: [
      { id: "F1", text: "명시", source: "photo", grade: "C" },
      { text: "자동", source: "memo", grade: "C" }
    ],
    unknowns: []
  });
  assert.deepEqual(a.candidates.map((c) => c.id), ["F1", "F2"]);

  // 순서가 반대여도 마찬가지다 — 명시 ID를 먼저 수집하기 때문이다
  const b = normalizeSpark({
    candidates: [
      { text: "자동", source: "memo", grade: "C" },
      { id: "F1", text: "명시", source: "photo", grade: "C" }
    ],
    unknowns: ["문자열 unknown", { id: "U1", text: "명시 unknown" }]
  });
  assert.deepEqual(b.candidates.map((c) => c.id), ["F2", "F1"]);
  assert.deepEqual(b.unknowns.map((u) => u.id), ["U2", "U1"]); // U1은 명시가 쓰고, 문자열은 U2로 회피
});

// ---------------------------------------------------------------------
console.log("결정과 파생");
// ---------------------------------------------------------------------

test("setDecision은 입력 record를 수정하지 않고 새 상태를 반환한다", () => {
  const rec = recordFromRaw("메모", SPARK_TWO);
  const next = setDecision(rec, "F1", "confirmed");
  assert.notEqual(next, rec);
  assert.notEqual(next.candidates, rec.candidates);
  assert.equal(rec.candidates[0].decision, "undecided"); // 원본 무오염
  assert.equal(next.candidates[0].decision, "confirmed");
});

test("candidates를 고쳐도 이미 파생한 confirmedFacts 결과가 오염되지 않는다", () => {
  const rec = setDecision(recordFromRaw("메모", SPARK_TWO), "F1", "confirmed");
  const facts = confirmedFacts(rec); // [F1]
  assert.equal(facts.length, 1);

  // 이후 상태가 바뀌어도 이미 받은 파생 결과(스냅샷)는 그대로다
  const after = setDecision(rec, "F1", "rejected");
  assert.equal(facts.length, 1);
  assert.equal(facts[0].decision, "confirmed");
  assert.equal(confirmedFacts(after).length, 0);

  // 파생 결과는 후보 객체를 공유하지 않는다 — 사본을 고쳐도 원본이 무오염
  assert.notEqual(facts[0], rec.candidates[0]);
  facts[0].decision = "rejected";
  facts[0].text = "조작됨";
  assert.equal(rec.candidates[0].decision, "confirmed");
  assert.equal(rec.candidates[0].text, "아이가 풀밭 길 위에 서 있다");
});

test("거절한 후보는 confirmedFacts에 절대 없다", () => {
  let rec = recordFromRaw("메모", SPARK_TWO);
  rec = setDecision(rec, "F1", "rejected");
  rec = setDecision(rec, "F2", "confirmed");
  const facts = confirmedFacts(rec);
  assert.deepEqual(facts.map((f) => f.id), ["F2"]);
  assert.ok(facts.every((f) => f.decision === "confirmed"));
});

test("setDecision은 계약 밖 decision과 없는 후보 id를 거부한다", () => {
  const rec = recordFromRaw("메모", SPARK_TWO);
  assert.throws(() => setDecision(rec, "F1", "maybe"), TypeError);
  assert.throws(() => setDecision(rec, "F999", "confirmed"), Error);
});

test("setDecision은 정확히 하나의 후보만 변경하고, 모호한 id(중복)는 거부한다", () => {
  const rec = recordFromRaw("메모", SPARK_TWO);
  const next = setDecision(rec, "F1", "confirmed");
  // 정확히 하나의 후보만 바뀌었다
  assert.equal(
    next.candidates.filter((c, i) => c.decision !== rec.candidates[i].decision).length,
    1
  );
  assert.equal(next.candidates.filter((c) => c.decision === "confirmed").length, 1);
  assert.equal(next.candidates.length, rec.candidates.length);

  // id가 0개 또는 2개 이상 맞는 레코드는 전부 거부한다
  assert.throws(() => setDecision(rec, "없는id", "confirmed"), Error);
  const corrupt = {
    mode: "live",
    memoText: "",
    candidates: [
      { id: "F1", text: "a", source: "photo", grade: "C", decision: "undecided" },
      { id: "F1", text: "b", source: "memo", grade: "C", decision: "undecided" }
    ],
    unknowns: [],
    gate1Complete: false
  };
  assert.throws(() => setDecision(corrupt, "F1", "confirmed"), Error);
});

// ---------------------------------------------------------------------
console.log("Gate 1 완료 조건");
// ---------------------------------------------------------------------

test("undecided가 하나라도 있으면 gate1Complete는 false다", () => {
  let rec = recordFromRaw("메모", SPARK_TWO);
  assert.equal(gate1Complete(rec), false); // 전부 undecided
  rec = setDecision(rec, "F1", "confirmed");
  assert.equal(gate1Complete(rec), false); // F2가 아직 undecided
  rec = setDecision(rec, "F2", "rejected");
  assert.equal(gate1Complete(rec), true); // 후보 1개 이상 + undecided 0
});

test("거절도 결정이다 — 전부 거절하면 gate1Complete는 true다", () => {
  let rec = recordFromRaw("메모", SPARK_TWO);
  rec = setDecision(rec, "F1", "rejected");
  rec = setDecision(rec, "F2", "rejected");
  assert.equal(gate1Complete(rec), true);
});

test("유효하지 않은 decision 값은 결정으로 인정되지 않아 Gate가 완료되지 않는다", () => {
  // 대조: 허용값(confirmed|rejected)만 있으면 완료다
  const valid = restore(
    JSON.stringify({
      mode: "live",
      memoText: "메모",
      candidates: [{ id: "F1", text: "a", source: "photo", grade: "C", decision: "confirmed" }],
      unknowns: []
    })
  );
  assert.equal(gate1Complete(valid), true);

  // 계약 밖 decision 값("maybe")은 undecided와 마찬가지로 미결정이다.
  // 이 값은 모듈 경로(정규화·저장·setDecision)로는 만들 수 없는 깨진 상태라 직접 만든다.
  const broken = {
    mode: "live",
    memoText: "메모",
    candidates: [
      { id: "F1", text: "a", source: "photo", grade: "C", decision: "confirmed" },
      { id: "F2", text: "b", source: "memo", grade: "C", decision: "maybe" }
    ],
    unknowns: [],
    gate1Complete: true
  };
  assert.equal(gate1Complete(broken), false);
});

test("후보가 0개면 undecided가 없어도 gate1Complete는 false다 (unknowns는 카운트에 넣지 않는다)", () => {
  assert.equal(gate1Complete(createDayRecord()), false);

  const base = Object.assign(createDayRecord(), { memoText: "메모" });
  const token = beginExtraction(base);
  const out = applyExtraction(base, token, { candidates: [], unknowns: ["질문 하나"] });
  assert.equal(out.candidates.length, 0);
  assert.equal(out.unknowns.length, 1);
  assert.equal(gate1Complete(out), false);
});

// ---------------------------------------------------------------------
console.log("무효화");
// ---------------------------------------------------------------------

test("invalidateExtraction 후 후보·결정·unknowns가 전부 비워진다", () => {
  let rec = recordFromRaw("들이랑 밭길에서 놀았다", SPARK_TWO);
  rec = setDecision(rec, "F1", "confirmed");

  const invalidated = invalidateExtraction(rec);
  assert.deepEqual(invalidated.candidates, []);
  assert.deepEqual(invalidated.unknowns, []);
  assert.equal(gate1Complete(invalidated), false);
  assert.equal(invalidated.memoText, "들이랑 밭길에서 놀았다"); // 입력 자체는 유지

  // 원본도 무오염 (불변)
  assert.equal(rec.candidates.length, 2);
  assert.equal(rec.candidates[0].decision, "confirmed");
});

// ---------------------------------------------------------------------
console.log("저장/복원");
// ---------------------------------------------------------------------

test("serialize → restore 왕복이 동등하다", () => {
  let rec = recordFromRaw("들이랑 밭길에서 놀았다", SPARK_TWO);
  rec = setDecision(rec, "F1", "confirmed");
  rec = setDecision(rec, "F2", "rejected");

  const json = serialize(rec);
  assert.equal(typeof json, "string");
  const back = restore(json);
  assert.deepEqual(back, rec);
  assert.equal(gate1Complete(back), gate1Complete(rec));
});

test("저장 결과에는 계약의 9개 필드만 있고 사진/base64는 닿지 않는다 (S4 확장)", () => {
  const rec = recordFromRaw("메모", SPARK_TWO);
  const dirty = Object.assign({}, rec, { photoDataUrl: "data:image/jpeg;base64,AAAA" });

  const stored = JSON.parse(serialize(dirty));
  assert.deepEqual(Object.keys(stored).sort(), [
    "briefing",
    "candidates",
    "gate1Complete",
    "memoText",
    "mode",
    "pageSentences",
    "questionCard",
    "testimony",
    "unknowns"
  ]);
  assert.equal(stored.photoDataUrl, undefined);
  assert.equal(JSON.stringify(stored).indexOf("base64"), -1);
});

test("깨진 JSON과 계약에서 벗어난 형태는 restore가 null을 반환한다", () => {
  assert.equal(restore("{깨진 json"), null);
  assert.equal(restore(""), null);
  assert.equal(restore(null), null);
  assert.equal(restore(42), null);
  assert.equal(restore("42"), null); // JSON이지만 객체가 아니다

  const brokenSources = [
    // 후보 source가 계약 밖
    {
      mode: "live",
      memoText: "메모",
      candidates: [{ id: "F1", text: "x", source: "video", grade: "C", decision: "undecided" }],
      unknowns: []
    },
    // decision이 계약 밖
    {
      mode: "live",
      memoText: "메모",
      candidates: [{ id: "F1", text: "x", source: "memo", grade: "C", decision: "maybe" }],
      unknowns: []
    },
    // memoText 누락
    { mode: "live", candidates: [], unknowns: [] },
    // unknown이 저장 형식(객체)이 아니다
    { mode: "live", memoText: "메모", candidates: [], unknowns: ["문자열 unknown"] }
  ];
  for (const data of brokenSources) {
    assert.equal(restore(JSON.stringify(data)), null);
  }
});

test("restore는 저장된 gate1Complete를 믿지 않고 후보에서 다시 계산한다", () => {
  const rec = restore(
    JSON.stringify({
      mode: "live",
      memoText: "메모",
      candidates: [{ id: "F1", text: "x", source: "memo", grade: "C", decision: "undecided" }],
      unknowns: [],
      gate1Complete: true // 조작된 저장값
    })
  );
  assert.equal(rec.gate1Complete, false);
});

test("restore는 후보/unknown ID가 중복된 저장 데이터를 거부한다", () => {
  assert.equal(
    restore(
      JSON.stringify({
        mode: "live",
        memoText: "메모",
        candidates: [
          { id: "F1", text: "a", source: "photo", grade: "C", decision: "undecided" },
          { id: "F1", text: "b", source: "memo", grade: "C", decision: "confirmed" }
        ],
        unknowns: []
      })
    ),
    null
  );
  assert.equal(
    restore(
      JSON.stringify({
        mode: "live",
        memoText: "메모",
        candidates: [],
        unknowns: [
          { id: "U1", text: "a" },
          { id: "U1", text: "b" }
        ]
      })
    ),
    null
  );
});

// ---------------------------------------------------------------------
console.log("S4 코어 확장");
// ---------------------------------------------------------------------

test("확장 필드(briefing/questionCard/pageSentences/testimony) 왕복이 동등하다", () => {
  let rec = recordFromRaw("메모", SPARK_TWO);
  rec = setDecision(rec, "F1", "confirmed");
  rec = Object.assign({}, rec, {
    briefing: [{ text: "오늘은 공원에 갔다.", factIds: ["F1"] }],
    questionCard: { text: "강아지는 무슨 색이었을까?", unknownId: "U1", premiseFactIds: ["F1"] },
    pageSentences: [{ text: "공원에 갔다.", factIds: ["F1"] }],
    testimony: [{ text: "재밌었어!", at: 1730000000000 }]
  });
  const back = restore(serialize(rec));
  assert.deepEqual(back, rec);
});

test("옛 5필드 저장본은 확장 필드 기본값으로 채워 복원된다 (하위호환)", () => {
  const legacy = JSON.stringify({
    mode: "sample",
    memoText: "옛 메모",
    candidates: [{ id: "F1", text: "x", source: "memo", grade: "C", decision: "confirmed" }],
    unknowns: [{ id: "U1", text: "q?" }],
    gate1Complete: false // 저장된 값과 무관하게 복원 시 후보에서 재계산된다
  });
  assert.deepEqual(restore(legacy), {
    mode: "sample",
    memoText: "옛 메모",
    candidates: [{ id: "F1", text: "x", source: "memo", grade: "C", decision: "confirmed" }],
    unknowns: [{ id: "U1", text: "q?" }],
    gate1Complete: true, // confirmed 1 + undecided 0 → 재계산 결과 true
    briefing: null,
    questionCard: null,
    pageSentences: [],
    testimony: []
  });
});

test("깨진 확장 필드가 하나라도 있으면 restore는 null을 반환한다", () => {
  const base = { mode: "live", memoText: "메모", candidates: [], unknowns: [] };
  const broken = [
    { briefing: [{ text: "", factIds: ["F1"] }] }, // 빈 text
    { briefing: [{ text: "x", factIds: "F1" }] }, // factIds가 배열 아님
    { briefing: "배열이 아닌 통째 문자열" }, // briefing이 배열 아님
    { questionCard: { text: "q", unknownId: 7, premiseFactIds: [] } }, // unknownId 문자열 아님
    { questionCard: { text: "q", unknownId: "U1" } }, // premiseFactIds 누락
    { questionCard: { text: "", unknownId: "U1", premiseFactIds: [] } }, // 빈 text
    { pageSentences: [{ text: "s", factIds: [1] }] }, // 숫자 id
    { testimony: [{ text: "t", at: "어제" }] }, // at 숫자 아님
    { testimony: [{ text: "t" }] } // at 누락
  ];
  for (const extra of broken) {
    assert.equal(restore(JSON.stringify(Object.assign({}, base, extra))), null);
  }
});

test("setDecision은 합성물을 초기화하고 testimony는 유지한다 (연쇄 무효화)", () => {
  let rec = recordFromRaw("메모", SPARK_TWO);
  rec = setDecision(rec, "F1", "confirmed");
  rec = Object.assign({}, rec, {
    briefing: [{ text: "줄", factIds: ["F1"] }],
    questionCard: { text: "q", unknownId: "U1", premiseFactIds: ["F1"] },
    pageSentences: [{ text: "s", factIds: ["F1"] }],
    testimony: [{ text: "아이 말", at: 123 }]
  });
  const next = setDecision(rec, "F2", "confirmed");
  assert.equal(next.briefing, null);
  assert.equal(next.questionCard, null);
  assert.deepEqual(next.pageSentences, []);
  assert.deepEqual(next.testimony, [{ text: "아이 말", at: 123 }]); // 유지
});

test("invalidateExtraction도 합성물을 초기화하고 testimony는 유지한다", () => {
  let rec = recordFromRaw("메모", SPARK_TWO);
  rec = setDecision(rec, "F1", "confirmed");
  rec = Object.assign({}, rec, {
    briefing: [{ text: "줄", factIds: ["F1"] }],
    questionCard: { text: "q", unknownId: "U1", premiseFactIds: ["F1"] },
    pageSentences: [{ text: "s", factIds: ["F1"] }],
    testimony: [{ text: "아이 말", at: 123 }]
  });
  const next = invalidateExtraction(rec);
  assert.equal(next.briefing, null);
  assert.equal(next.questionCard, null);
  assert.deepEqual(next.pageSentences, []);
  assert.deepEqual(next.testimony, [{ text: "아이 말", at: 123 }]); // 유지
  assert.deepEqual(next.candidates, []);
});

test("validateComposition: 전부 확정 사실을 1개 이상 인용하면 ok다", () => {
  const result = validateComposition(
    [
      { text: "a", factIds: ["F1"] },
      { text: "b", factIds: ["F1", "F2"] }
    ],
    ["F1", "F2"]
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("validateComposition: 인용 없음·미확인 인용·깨진 형식을 위반으로 잡는다", () => {
  const result = validateComposition(
    [
      { text: "인용 없는 문장", factIds: [] },
      { text: "거절된 사실 인용", factIds: ["F9"] },
      { text: "정상 문장", factIds: ["F1"] },
      null
    ],
    ["F1"]
  );
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 3);
  assert.deepEqual(result.violations.map((v) => v.index), [0, 1, 3]);
  assert.ok(result.violations[1].reason.includes("F9"));
});

test("synthesisFacts는 confirmedFacts와 같고 거절·미결정을 제외한다", () => {
  let rec = recordFromRaw("메모", SPARK_TWO);
  rec = setDecision(rec, "F1", "confirmed"); // F2는 미결정
  assert.deepEqual(synthesisFacts(rec).map((f) => f.id), ["F1"]);
  rec = setDecision(rec, "F2", "rejected"); // 거절도 제외
  assert.deepEqual(synthesisFacts(rec).map((f) => f.id), ["F1"]);
  assert.deepEqual(synthesisFacts(rec), confirmedFacts(rec)); // 명시적 별칭
});

// ---------------------------------------------------------------------
console.log("S5 LEAK 검사");
// ---------------------------------------------------------------------

test("checkLeaks: 금지 어휘가 인용 원문에 없으면 위반이다", () => {
  const result = checkLeaks(
    [{ text: "신나게 밭길을 달렸다", factIds: ["F1"] }],
    { F1: { text: "밭길에서 놀았다" } }
  );
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1);
  assert.ok(result.violations[0].reason.includes("신나"));
});

test("checkLeaks: 같은 어휘라도 인용 원문에 있으면 통과다", () => {
  const result = checkLeaks(
    [{ text: "친구와 함께 놀았다", factIds: ["F1"] }],
    { F1: { text: "친구와 함께 밭길을 걸었다" } }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("checkLeaks: 인용 없는 문장의 금지 어휘는 무조건 위반이다", () => {
  const result = checkLeaks(
    [
      { text: "무서운 강아지", factIds: ["F1"] }, // 무서 — 원문에 없음
      { text: "행복한 하루", factIds: [] }, // 인용 없음 → 원문 근거 자체가 없다
      { text: "밭길에서 놀았다", factIds: ["F1"] } // 깨끗함
    ],
    { F1: { text: "밭길에서 놀았다" } }
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((v) => v.index), [0, 1]);
});

test("checkLeaks: 문자열 원문(id → text) 형태도 받고, 깨진 배열은 위반 처리한다", () => {
  const ok = checkLeaks([{ text: "밭길에서 놀았다", factIds: ["F1"] }], { F1: "밭길에서 놀았다" });
  assert.equal(ok.ok, true);
  const broken = checkLeaks("배열 아님", {});
  assert.equal(broken.ok, false);
  assert.equal(broken.violations[0].reason, "문장 배열이 아니다");
});

// ---------------------------------------------------------------------
console.log("추출 토큰 가드");
// ---------------------------------------------------------------------

test("낡은 토큰으로 applyExtraction 하면 무시된다", () => {
  const base = createDayRecord();
  const stale = beginExtraction(base);
  const fresh = beginExtraction(base);

  const ignored = applyExtraction(base, stale, SPARK_TWO);
  assert.equal(ignored, base); // 아무 일도 없었다 — 원본 그대로
  assert.equal(base.candidates.length, 0);

  const applied = applyExtraction(base, fresh, {
    candidates: [{ text: "새 응답", source: "memo", grade: "C" }],
    unknowns: ["새 질문?"]
  });
  assert.deepEqual(applied.candidates.map((c) => c.text), ["새 응답"]);
  assert.deepEqual(applied.unknowns, [{ id: "U1", text: "새 질문?" }]);
  assert.ok(applied.candidates.every((c) => c.decision === "undecided")); // 새 추출은 undecided에서 시작
});

test("메모 수정으로 레코드가 교체된 뒤 도착한 응답은 무시된다 (무효화 규칙)", () => {
  const base = Object.assign(createDayRecord(), { memoText: "옛 메모" });
  const token = beginExtraction(base);

  // 사용자가 메모를 고쳤다 — 새 텍스트를 넣고 기존 추출 결과를 무효화한다
  const edited = invalidateExtraction(Object.assign({}, base, { memoText: "새 메모" }));

  const out = applyExtraction(edited, token, SPARK_TWO);
  assert.equal(out, edited); // 이전 응답은 이 레코드에 닿지 않는다
  assert.equal(out.candidates.length, 0);
  assert.equal(out.memoText, "새 메모");
});

test("구조가 깨진 raw(candidates가 배열 아님)로는 상태를 덮지 않는다", () => {
  const rec = recordFromRaw("메모", SPARK_TWO);
  const token = beginExtraction(rec);
  assert.equal(applyExtraction(rec, token, null), rec);
  assert.equal(applyExtraction(rec, token, { candidates: null }), rec);
  assert.equal(applyExtraction(rec, token, "문자열 raw"), rec);
});

test("STORAGE_KEY는 브리프의 taw-day-v1이다", () => {
  assert.equal(STORAGE_KEY, "taw-day-v1");
});

// ---------------------------------------------------------------------
console.log("S7-fix: NFC leak check (A2) + burned IDs (A3)");
// ---------------------------------------------------------------------

test("checkLeaks: NFD로 온 문장의 금지 어휘도 NFC 정규화로 잡는다 (A2)", () => {
  const nfd = "기뻐".normalize("NFD");
  const result = checkLeaks(
    [{ text: "아이가 " + nfd + " 뛰어 다닌다", factIds: ["F1"] }],
    { F1: "아이가 뛰어 다닌다" }
  );
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].reason, "원문에 없는 표현이 들어갔다: 기뻐");
});

test("checkLeaks: NFD로 온 인용 원문에 있던 어휘는 통과다 (A2)", () => {
  const result = checkLeaks(
    [{ text: "아이가 기뻐 뛰어 다닌다", factIds: ["F1"] }],
    { F1: "아이가 " + "기뻐".normalize("NFD") + " 뛰어 다닌다" }
  );
  assert.equal(result.ok, true);
});

test("normalizeSpark: 소진된 ID는 자동 발급이 회피한다 (A3)", () => {
  const result = normalizeSpark({
    candidates: [
      { text: "첫 후보", source: "photo", grade: "C" },
      { text: "둘째 후보", source: "memo", grade: "B" }
    ]
  }, new Set(["F1", "F2"]));
  assert.deepEqual(result.candidates.map((c) => c.id), ["F3", "F4"]);
  assert.deepEqual(result.debug, []);
});

test("normalizeSpark: 명시 ID가 소진 집합에 있으면 그 후보는 새 ID로 재발급된다 (A3)", () => {
  const result = normalizeSpark({
    candidates: [
      { id: "F1", text: "구 세대 ID를 달고 온 후보", source: "photo", grade: "C" },
      { text: "ID 없는 후보", source: "memo", grade: "C" }
    ]
  }, ["F1"]);
  const ids = result.candidates.map((c) => c.id);
  assert.equal(ids.length, 2);
  assert.ok(ids.indexOf("F1") === -1); // 구 세대 ID는 최종 레코드에 없다
  assert.equal(new Set(ids).size, 2);  // 발급된 ID는 전부 유일하다
  assert.deepEqual(result.debug, []);  // 후보는 격리되지 않고 보존된다
});

test("normalizeSpark: 소진 집합이 비면 기존 발급(F1…)과 동일하다 (A3 하위호환)", () => {
  const result = normalizeSpark(SPARK_TWO, []);
  assert.deepEqual(result.candidates.map((c) => c.id), ["F1", "F2"]);
});

test("applyExtraction은 소진 ID를 정규화까지 전달한다 (A3 — 앱의 실제 적용 경로)", () => {
  const base = Object.assign(createDayRecord(), { memoText: "메모" });
  const token = beginExtraction(base);
  const out = applyExtraction(base, token, SPARK_TWO, new Set(["F1", "F2"]));
  assert.deepEqual(out.candidates.map((c) => c.id), ["F3", "F4"]);
});

// ---------------------------------------------------------------------
console.log("");
console.log(passed + " passed, " + failures.length + " failed");
if (failures.length > 0) {
  process.exit(1);
}
