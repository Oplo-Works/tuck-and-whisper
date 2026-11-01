// Tuck and Whisper — UI 문자열 테이블 (i18n).
// 범위는 화면 표시 문자열만이다. 모델 프로토콜(시스템 프롬프트·교정 피드백 형식·재시도
// 지시문), 데이터 계약(taw-day-v1), SAMPLE_DAY·LEAK_WORDS 콘텐츠는 의도적으로 여기에
// 없다 — 콘텐츠 언어는 입력을 따라가고, 프로토콜은 하니스 v2가 검증하는 불변 계약이다.
//
// 언어 집합: Muse Voice가 "extensively verified"로 공개한 25개 (검증 가능한 정의).
// 이 파일은 en·ko가 완성된 상태다 — 나머지 23개 테이블은 따까리의 번역·검증 후 같은
// 구조로 추가되고, 언어 선택 메뉴는 이 테이블의 키를 따라 자동으로 늘어난다.
//
// t(key, vars): 없는 키는 en으로 폴백, 그래도 없으면 key 그대로. {name} 형식 치환.
(function () {
  "use strict";

  const TABLE = {
    en: {
      // --- 정적 키 (패킷 표) ---
      "capture.title": "Today's day",
      "capture.hint": "One photo and a short memo. The photo is never saved.",
      "capture.photoLabel": "Photo (choose from the gallery)",
      "capture.memoLabel": "Memo",
      "capture.memoPlaceholder": "e.g. At Grandpa's house in the countryside, playing on the field path with Deuri, a puppy born a month ago.",
      "capture.voiceLabel": "Voice memo (a recording file — you can choose the .m4a as-is)",
      "capture.transcribe": "Fill the memo by voice",
      "capture.extract": "Extract",
      "capture.loadSample": "Load sample day",
      "capture.needBoth": "You need both a photo and a memo to extract.",
      "capture.backToGate1": "← Gate 1 (keep reviewing)",
      "newDay.button": "Start a new day",
      "newDay.confirmText": "This erases today's candidates and decisions. Start a new day?",
      "newDay.start": "Start",
      "newDay.cancel": "Cancel",
      "gate1.title": "Check the facts (Gate 1)",
      "gate1.gotoConfirmed": "See the confirmed list",
      "gate1.editMemo": "Edit the memo",
      "gate1.empty": "No candidates — there is no extraction yet, or a memo edit invalidated it.",
      "gate1.notKnown": "Not known yet",
      "confirmed.title": "Confirmed facts",
      "confirmed.hint": "Only confirmed facts appear here — rejected and undecided ones never reach this list.",
      "confirmed.empty": "No facts confirmed yet.",
      "confirmed.back": "← Gate 1",
      "confirmed.makePreview": "Make the preview",
      "preview.title": "Before-bedtime preview",
      "preview.noFacts": "Nothing to compose — every candidate was rejected.",
      "preview.fallback": "Tonight, just as it happened — the confirmed facts, word for word.",
      "preview.briefing": "Briefing",
      "preview.briefingEmpty": "No briefing yet.",
      "preview.resynthesize": "Compose again",
      "preview.questionCard": "Question card",
      "preview.unknownLabel": "The unknown to ask about",
      "preview.premiseLabel": "Confirmed facts behind it (optional — tap to choose)",
      "preview.draft": "Draft the question",
      "preview.questionPlaceholder": "Once drafted, you can edit the question here",
      "preview.openBedtime": "Bedtime page",
      "preview.back": "← Confirmed facts",
      "bedtime.title": "Bedtime page",
      "bedtime.story": "Tonight's story",
      "bedtime.pageEmpty": "No page sentences yet.",
      "bedtime.recompose": "Compose again",
      "bedtime.questionCard": "Question card",
      "bedtime.testimony": "What the child said",
      "bedtime.testimonyHint": "What the child answered is a record only — it is never promoted to a fact.",
      "bedtime.testimonyPlaceholder": "One line of the child's answer",
      "bedtime.save": "Save",
      "bedtime.back": "← Preview",
      "restricted.banner": "Tonight, the photo and a question arrived first.",
      "restricted.question": "Question",
      "debug.summary": "Debug (for developers)",
      "debug.malformed": "Debug: malformed items (for developers)",
      "debug.raw": "Debug: raw model output (for developers)",
      "debug.errorHeader": "— error —",
      "debug.rawHeader": "— raw Worker response —",
      "debug.none": "(none — network error)",
      // --- 동적 키 (app.js) ---
      "mode.sample": "Sample day",
      "mode.live": "Live day",
      "decision.confirm": "Confirm",
      "decision.reject": "Reject",
      "decision.undecided": "Undecided",
      "capture.selectedPhoto": "Selected photo: {name} — the photo is never saved (gone on refresh).",
      "capture.extracting": "Extracting…",
      "capture.invalidatedMemo": "The memo changed — the previous extraction (candidates and decisions) was all invalidated.",
      "capture.invalidatedPhoto": "The photo changed — the previous extraction (candidates and decisions) was all invalidated.",
      "capture.noCandidates": "No candidates could be made. Check the debug area — you can try again.",
      "capture.extractFailed": "Extraction failed: {message} — your inputs are untouched. You can try again.",
      "capture.selectedRecording": "Selected recording: {name} ({mb}MB)",
      "capture.overSize": " — over 32MB, cannot transcribe",
      "capture.transcribing": "Transcribing…",
      "capture.transcribingLong": "Transcribing… (this can take tens of seconds)",
      "capture.durationOver": "The recording exceeds 10 minutes (about {minutes} min — limit 10). Try a recording of 10 minutes or less.",
      "capture.fileTooLarge": "The recording file is too large (currently {mb}MB — limit 32MB). Try a shorter recording.",
      "capture.cannotConvert": "This file cannot be converted — you can still type the memo. (cause: {message})",
      "capture.transcribeDone": "Transcription done — the memo was replaced with the transcript.",
      "capture.transcribeFailed": "Transcription failed: {message} — the memo and the recording selection remain. You can try again.",
      "photo.noSaved": "Photos are not saved",
      "photo.alt": "Today's photo (session only — never saved)",
      "picture.alt": "Today's picture (session only — never saved)",
      "memo.none": "(no memo)",
      "gate1.allDecided": "Every candidate is decided.",
      "gate1.remaining": "{n} candidate(s) left",
      "gate1.batchConfirm": "Batch-confirm grade C ({n})",
      "restricted.q1": "What was the most memorable moment today?",
      "restricted.q2": "Who did you play with the longest today?",
      "restricted.q3": "What was the most surprising thing today?",
      "restricted.q4": "When did you laugh the hardest today?",
      "restricted.q5": "Of everything you saw outside today, what stuck with you most?",
      "restricted.q6": "Did you learn anything new today — what was it?",
      "bedtime.stylize": "Turn the photo into a picture",
      "bedtime.stylizing": "Making the picture…",
      "bedtime.stylizeHint": "The picture shows only inside this session — it is not saved.",
      "bedtime.stylizeNoPhoto": "Photos are not saved, so the picture disappears on refresh — only the sentences are shown.",
      "preview.composing": "Composing the briefing…",
      "preview.briefingFailed": "Briefing composition failed: {message} — you can try again.",
      "page.composing": "Composing the page sentences…",
      "page.composeFailed": "Page composition failed: {message} — you can try again.",
      "style.failed": "Stylization failed: {message}",
      "provenance.missing": "(a fact that is no longer in the confirmed list)",
      "question.noUnknown": "No unknowns",
      "question.drafting": "Drafting…",
      "question.meta": "unknown: {id} · premise: {ids} — you can edit the text.",
      "question.none": "none",
      "question.noDraft": "No draft yet — pick an unknown and premises, draft it, and then you can edit the text.",
      "question.makeInPreview": "You can make the question card in the preview.",
      "question.draftFailed": "Question drafting failed: {message} — you can try again.",
      "error.unknown": "unknown error",
      "error.workerHttp": "The Worker answered with HTTP {status}",
      "error.notJson": "The response is not JSON",
      "error.noContent": "The response has no choices[0].message.content",
      "error.noTranscript": "The response has no transcript, or it is empty",
      "error.badShapeCandidates": "The response shape violates the contract (candidates is not an array)",
      "error.badShapeLines": "The response shape violates the contract (lines is not an array)",
      "error.badShapeText": "The response shape violates the contract (text is missing)",
      "error.badShapeSentences": "The response shape violates the contract (sentences is not an array)",
      "error.noImage": "No image found in the response (response format undocumented)",
      "error.cannotReadJson": "{what} could not be read as JSON",
      "parse.briefing": "the briefing answer",
      "parse.page": "the page answer"
    },
    ko: {
      // --- 정적 키 (패킷 표 — 현행 그대로) ---
      "capture.title": "오늘의 하루",
      "capture.hint": "사진 한 장과 짧은 메모. 사진은 저장되지 않는다.",
      "capture.photoLabel": "사진 (갤러리에서 선택)",
      "capture.memoLabel": "메모",
      "capture.memoPlaceholder": "예: 한국 할아버지 집에서, 태어난 지 한 달 된 강아지 들이랑 밭길에서 놀았어.",
      "capture.voiceLabel": "음성 메모 (녹음 파일 — m4a 그대로 선택해도 된다)",
      "capture.transcribe": "음성으로 메모 채우기",
      "capture.extract": "추출",
      "capture.loadSample": "Load sample day",
      "capture.needBoth": "사진과 메모가 모두 있어야 추출할 수 있다.",
      "capture.backToGate1": "← Gate 1 (검토 계속)",
      "newDay.button": "새 하루 시작",
      "newDay.confirmText": "지금 하루의 후보와 결정이 지워져요. 새 하루를 시작할까요?",
      "newDay.start": "시작",
      "newDay.cancel": "취소",
      "gate1.title": "사실 확인 (Gate 1)",
      "gate1.gotoConfirmed": "확정 목록 보기",
      "gate1.editMemo": "메모 수정",
      "gate1.empty": "후보가 없다 — 추출 결과가 없거나 메모 변경으로 무효화되었다.",
      "gate1.notKnown": "Not known yet",
      "confirmed.title": "확정 목록",
      "confirmed.hint": "여기는 확정한 사실만 보인다 — 거절·미결정은 닿지 않는다.",
      "confirmed.empty": "확정된 사실이 아직 없다.",
      "confirmed.back": "← Gate 1",
      "confirmed.makePreview": "프리뷰 만들기",
      "preview.title": "취침 전 프리뷰",
      "preview.noFacts": "합성할 사실이 없다 — 모든 후보를 거절했다.",
      "preview.fallback": "오늘은 꾸밈없이, 확정한 사실 그대로예요",
      "preview.briefing": "브리핑",
      "preview.briefingEmpty": "아직 브리핑이 없다.",
      "preview.resynthesize": "다시 합성",
      "preview.questionCard": "질문 카드",
      "preview.unknownLabel": "물어볼 unknown",
      "preview.premiseLabel": "전제가 될 확정 사실 (안 골라도 된다 — 탭으로 고른다)",
      "preview.draft": "질문 초안 만들기",
      "preview.questionPlaceholder": "초안을 만들면 여기서 수정할 수 있다",
      "preview.openBedtime": "취침 페이지",
      "preview.back": "← 확정 목록",
      "bedtime.title": "취침 페이지",
      "bedtime.story": "오늘 이야기",
      "bedtime.pageEmpty": "아직 페이지 문장이 없다.",
      "bedtime.recompose": "다시 합성",
      "bedtime.questionCard": "질문 카드",
      "bedtime.testimony": "증언",
      "bedtime.testimonyHint": "아이가 대답한 말은 기록일 뿐이다 — 사실로 승격되지 않는다.",
      "bedtime.testimonyPlaceholder": "아이의 대답 한 마디",
      "bedtime.save": "기록",
      "bedtime.back": "← 프리뷰",
      "restricted.banner": "오늘은 사진과 질문이 먼저 도착했어요",
      "restricted.question": "질문",
      "debug.summary": "디버그 (개발자용)",
      "debug.malformed": "디버그: 형식 깨진 항목 (개발자용)",
      "debug.raw": "디버그: 모델 원문 (개발자용)",
      "debug.errorHeader": "— 오류 —",
      "debug.rawHeader": "— Worker 원문 응답 —",
      "debug.none": "(없음 — 네트워크 오류)",
      // --- 동적 키 (app.js 현행 문구 그대로) ---
      "mode.sample": "Sample day",
      "mode.live": "라이브 하루",
      "decision.confirm": "확정",
      "decision.reject": "거절",
      "decision.undecided": "미결정",
      "capture.selectedPhoto": "선택한 사진: {name} — 사진은 저장되지 않는다 (새로고침하면 사라진다).",
      "capture.extracting": "추출 중…",
      "capture.invalidatedMemo": "메모가 바뀌어 이전 추출 결과(후보·결정)를 전부 무효화했다.",
      "capture.invalidatedPhoto": "사진이 바뀌어 이전 추출 결과(후보·결정)를 전부 무효화했다.",
      "capture.noCandidates": "후보를 하나도 만들지 못했다. 디버그 영역을 확인하고 다시 시도할 수 있다.",
      "capture.extractFailed": "추출에 실패했다: {message} — 입력은 그대로 남아 있다. 다시 시도할 수 있다.",
      "capture.selectedRecording": "선택한 녹음: {name} ({mb}MB)",
      "capture.overSize": " — 32MB 초과라 전사할 수 없다",
      "capture.transcribing": "전사 중…",
      "capture.transcribingLong": "전사 중… (몇십 초 걸릴 수 있다)",
      "capture.durationOver": "녹음이 10분을 초과한다 (약 {minutes}분 — 상한 10분). 10분 이하 녹음으로 다시 시도할 수 있다.",
      "capture.fileTooLarge": "녹음 파일이 너무 크다 (현재 {mb}MB — 상한 32MB). 더 짧은 녹음으로 다시 시도할 수 있다.",
      "capture.cannotConvert": "이 파일은 변환할 수 없습니다 — 텍스트 메모는 그대로 쓸 수 있다. (원인: {message})",
      "capture.transcribeDone": "전사 완료 — 메모를 전사 결과로 교체했다.",
      "capture.transcribeFailed": "전사에 실패했다: {message} — 메모와 녹음 선택은 그대로 남아 있다. 다시 시도할 수 있다.",
      "photo.noSaved": "사진은 저장되지 않음",
      "photo.alt": "오늘의 사진 (세션 전용 — 저장되지 않음)",
      "picture.alt": "오늘의 그림 (세션 전용 — 저장되지 않음)",
      "memo.none": "(메모 없음)",
      "gate1.allDecided": "모든 후보를 결정했다.",
      "gate1.remaining": "남은 후보: {n}개",
      "gate1.batchConfirm": "C 등급 일괄 확정 ({n}개)",
      "restricted.q1": "오늘 가장 기억에 남는 순간은 뭐였어?",
      "restricted.q2": "오늘 누구랑 제일 오래 놀았어?",
      "restricted.q3": "오늘 제일 신기했던 것은 뭐였어?",
      "restricted.q4": "오늘 제일 크게 웃었던 순간은 언제였어?",
      "restricted.q5": "오늘 밖에서 본 것 중에 제일 기억에 남는 건 뭐였어?",
      "restricted.q6": "오늘 새로 알게 된 것이 있다면 뭐였어?",
      "bedtime.stylize": "사진을 그림으로 바꾸기",
      "bedtime.stylizing": "그림 만드는 중…",
      "bedtime.stylizeHint": "스타일화는 세션 안에서만 표시된다 — 저장되지 않는다.",
      "bedtime.stylizeNoPhoto": "사진은 저장되지 않아 그림은 새로고침하면 사라져요 — 문장만 표시한다.",
      "preview.composing": "브리핑을 만들고 있다…",
      "preview.briefingFailed": "브리핑 합성에 실패했다: {message} — 다시 시도할 수 있다.",
      "page.composing": "페이지 문장을 만들고 있다…",
      "page.composeFailed": "페이지 합성에 실패했다: {message} — 다시 시도할 수 있다.",
      "style.failed": "스타일화에 실패했다: {message}",
      "provenance.missing": "(현재 확정 목록에 없는 사실이다)",
      "question.noUnknown": "unknown이 없다",
      "question.drafting": "초안 작성 중…",
      "question.meta": "unknown: {id} · 전제: {ids} — 텍스트는 직접 고칠 수 있다.",
      "question.none": "없음",
      "question.noDraft": "아직 초안이 없다 — unknown과 전제를 고르고 초안을 만들면 수정할 수 있다.",
      "question.makeInPreview": "프리뷰에서 질문 카드를 만들 수 있어요.",
      "question.draftFailed": "질문 초안 작성에 실패했다: {message} — 다시 시도할 수 있다.",
      "error.unknown": "알 수 없는 오류",
      "error.workerHttp": "Worker가 HTTP {status}로 답했다",
      "error.notJson": "응답이 JSON이 아니다",
      "error.noContent": "응답에 choices[0].message.content가 없다",
      "error.noTranscript": "응답에 transcript가 없거나 비어 있다",
      "error.badShapeCandidates": "응답 구조가 계약과 다르다 (candidates가 배열이 아님)",
      "error.badShapeLines": "응답 구조가 계약과 다르다 (lines가 배열이 아님)",
      "error.badShapeText": "응답 구조가 계약과 다르다 (text가 없다)",
      "error.badShapeSentences": "응답 구조가 계약과 다르다 (sentences가 배열이 아님)",
      "error.noImage": "응답에서 이미지를 찾지 못했다 (응답 형식 미문서)",
      "error.cannotReadJson": "{what}를 JSON으로 읽을 수 없다",
      "parse.briefing": "브리핑 답안",
      "parse.page": "페이지 답안"
    }
  };

  // 자국어 표기(선택 메뉴) + 음성 전사 languageBias(전체 영어 이름) + RTL(ar만).
  // 25개 전부 미리 등록 — 나머지 23개 테이블이 들어오면 선택 메뉴에 자동 노출된다.
  const META = {
    en: { name: "English", bias: "English", rtl: false },
    ko: { name: "한국어", bias: "Korean", rtl: false },
    es: { name: "Español", bias: "Spanish", rtl: false },
    fr: { name: "Français", bias: "French", rtl: false },
    de: { name: "Deutsch", bias: "German", rtl: false },
    pt: { name: "Português", bias: "Portuguese", rtl: false },
    it: { name: "Italiano", bias: "Italian", rtl: false },
    ja: { name: "日本語", bias: "Japanese", rtl: false },
    zh: { name: "中文 (简体)", bias: "Chinese", rtl: false },
    hi: { name: "हिन्दी", bias: "Hindi", rtl: false },
    vi: { name: "Tiếng Việt", bias: "Vietnamese", rtl: false },
    ar: { name: "العربية", bias: "Arabic", rtl: true },
    ru: { name: "Русский", bias: "Russian", rtl: false },
    nl: { name: "Nederlands", bias: "Dutch", rtl: false },
    pl: { name: "Polski", bias: "Polish", rtl: false },
    tr: { name: "Türkçe", bias: "Turkish", rtl: false },
    id: { name: "Bahasa Indonesia", bias: "Indonesian", rtl: false },
    th: { name: "ไทย", bias: "Thai", rtl: false },
    uk: { name: "Українська", bias: "Ukrainian", rtl: false },
    sv: { name: "Svenska", bias: "Swedish", rtl: false },
    no: { name: "Norsk", bias: "Norwegian", rtl: false },
    da: { name: "Dansk", bias: "Danish", rtl: false },
    fi: { name: "Suomi", bias: "Finnish", rtl: false },
    cs: { name: "Čeština", bias: "Czech", rtl: false },
    ro: { name: "Română", bias: "Romanian", rtl: false }
  };

  let current = "en";

  function t(key, vars) {
    let s = TABLE[current] ? TABLE[current][key] : undefined;
    if (typeof s !== "string") s = TABLE.en[key]; // en 폴백
    if (typeof s !== "string") return key;
    if (vars) {
      for (const k of Object.keys(vars)) {
        s = s.split("{" + k + "}").join(String(vars[k]));
      }
    }
    return s;
  }

  function setLanguage(lang) {
    if (TABLE[lang]) current = lang; // 테이블에 없는 언어는 무시 — 현재 값 유지
  }

  function getLanguage() {
    return current;
  }

  // 테이블에 실제로 있는 언어만 반환 — 선택 메뉴가 이 목록을 그대로 쓴다.
  function languages() {
    return Object.keys(TABLE).map(function (code) {
      const m = META[code] || {};
      return { code: code, name: m.name || code, bias: m.bias || code, rtl: !!m.rtl };
    });
  }

  function languageInfo(code) {
    const m = META[code];
    return m ? { code: code, name: m.name, bias: m.bias, rtl: !!m.rtl } : null;
  }

  window.TAW_I18N = {
    t: t,
    setLanguage: setLanguage,
    getLanguage: getLanguage,
    languages: languages,
    languageInfo: languageInfo
  };
})();
