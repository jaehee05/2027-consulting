# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

This is a single-page admin/student web app for a consulting (멘토링) business, packaged as:

- **`index.html`** — entire web app in one HTML file (~4500 lines, ~290 functions). All UI, routing, Firestore reads/writes, and rendering live here. Talks to Firestore directly via the Firebase web SDK. State is held in a global `S` object; views re-render by replacing innerHTML. Search by function name (`renderAdminConsult`, `drawGradeGraph`, etc.) — there's no module system.
- **`functions/`** — Firebase Cloud Functions (Node 20, region `asia-northeast3`). Five exports in `index.js`:
  - `onBookingCreate`, `onRequestCreate`, `onRequestUpdate` — Firestore triggers that send 알림톡 on booking/request lifecycle events.
  - `loginToken` — HTTP endpoint that mints custom auth tokens.
  - `ppurioAdmin` — HTTP endpoint for admin CRUD on `settings/ppurio`. The web client must go through this; `settings/*` is blocked from clients by `firestore.rules`.
  - `ppurio.js` holds the alimtalk sending logic (`sendAlimtalk`, `sendAlimtalkToAdmins`). Templates and `footer` come from `settings/ppurio`; `footer` is auto-injected into every send context, so `var8: "${footer}"` resolves without per-call wiring.
- **`vm-proxy/`** — tiny Node HTTP server that proxies outbound POSTs to `message.ppurio.com`. Cloud Functions don't talk to ppurio directly because ppurio whitelists by IP — the proxy runs on a fixed-IP VM. Functions reach it via `PPURIO_PROXY_URL` + `PPURIO_PROXY_SECRET` env vars (set in `functions/.env`).
- **`mobile/`** — Capacitor wrapper (iOS/Android). `appId: kr.kjhedu.consulting2027`, `webDir: www`. `mobile/build.sh` copies the root `index.html` + assets into `mobile/www/` before `cap sync`. For live reload during dev, uncomment `server.url` in `mobile/capacitor.config.ts`.

### Deploy split

The three deploy targets are **independent** — pick the right one for the change:

- **Web frontend (`index.html`, `privacy.html`, `favicon.png`)** — Vercel auto-deploys from GitHub `main` on every push. Live site: `https://www.kjhedu.kr/`. No `vercel.json` in repo; config is on the Vercel side. **A `git push` is sufficient** — do not run `firebase deploy --only hosting`. The `consulting-dd53f.web.app` Firebase Hosting site exists but is unused (404).
- **Cloud Functions** — `firebase deploy --only functions --project consulting-dd53f` (from repo root, after `cd functions && npm install`).
- **Firestore rules** — `firebase deploy --only firestore:rules --project consulting-dd53f`.
- **Storage rules** — `firebase deploy --only storage --project consulting-dd53f`. Storage was finally provisioned on 2026-09-02 (bucket `consulting-dd53f.firebasestorage.app`, `asia-northeast3`, production rules) and the repo's `storage.rules` released then; before that 질문 게시판 사진 첨부 could not work at all. If an upload ever fails again, check the error code the toast now prints (`storage/unauthorized` → rules, `storage/unauthenticated` → the Firebase Auth session died even though the app session survived).
- **Mobile app** — `cd mobile && npm run ios` (or `android`). Only needed for App/Play Store releases; not part of the web deploy flow.

Firebase project: **`consulting-dd53f`** (set as `default` in `.firebaserc`).

When the user wants a frontend change live, commit + push and trust Vercel. Don't try `firebase deploy --only hosting`.

### Security boundary

`firestore.rules` allows read/write to all collections **except `settings/*`**. The ppurio API key, account, sender profile, and admin phone list live in `settings/ppurio`. Anything touching credentials must go through Cloud Functions (Admin SDK) — never read or write `settings/*` from `index.html`. The admin UI's settings tab calls `ppurioAdmin` over HTTP.

### Per-grade exams (학년별 과목 구성)

Exams are grade-scoped. Each entry in `S.config.exams` carries:

- `grade` — `'고1' | '고2' | '고3'`, or `''`/absent meaning **all grades** (the pre-2026-09 default, so legacy exams keep working untouched).
- `korMode` / `matMode` — `'choice'` (default, 화법과 작문·언어와 매체 / 확률과 통계·미적분·기하) or `'common'` (선택과목 없는 공통형).
- `expMode` — `'choice'` (default, 사탐/과탐 2과목 선택), `'socsci'` (사회 + 과학 — 고1 학력평가), or `'integrated'` (통합사회 + 통합과학). The two fixed-subject modes differ only in the stored subject names; `examFixedExpSubjs(exam)` returns that pair (or `null` for `'choice'`) and is the single place the names live.
- `hasScienceII` only applies when `expMode==='choice'`; it is forced to `false` on save otherwise.

Score documents keep the **same field names in every mode** (`korSubj/korRaw`, `exp1Subj/exp1Raw`, …). Modes without a 선택과목 store a fixed subject name so `exam.gradeCuts[subj]` lookups stay uniform: `korSubj='국어'`, `matSubj='수학'`, and `exp1Subj`/`exp2Subj` from `examFixedExpSubjs`. Grade computation (`getExamGrade`, `getGradeSubjects`, `drawGradeGraph`) therefore needed no mode-awareness — only the input forms and the 선택과목 display row did (`scSubjLabel`, `scSubjRowLabel`).

Central helpers (all near `getExams`/`gcRelGroups` in `index.html`):

- `examsForStu(stu)` / `examsForGrade(g)` — the exam list for one student. **Every per-student view uses this, not `getExams()`**: student home, tablet session, 멘토링 상세, 성적 상세, 예약 상세, 학생 상세, 등급 추이 tabs, and the 멘토링 내용 tab index (`consultNotesEditorHtml`, `_currentConsultExamId`, and the tablet auto-save in `init`) — the note tabs and their auto-save must index the *same* filtered array or notes get written to the wrong exam.
- Score-management screens (`renderAdminScores`, `renderOpScores`) carry a 학년 탭 (`S.scoreGradeTab`): `scoreGradeFilter` narrows the students and `scoreGradeExams` narrows the exam columns together. `scoreGradeNormalize` clears the tab when the selected grade has no students left, and the tab bar hides itself when fewer than two grades are present.
- `examAppliesTo(exam, stu)` — for admin tables that list **all** students against **all** exams. Those keep every exam column and render `_OFF_GRADE` (`—`) instead of the 미입력 dot for off-grade pairs; per-exam counters divide by `examTargetCount(ex, list)`, not the whole roster. 성적 미입력 알림톡 targets are filtered the same way.
- `examKorCommon` / `examMatCommon` / `examExpInteg` / `examKorSubjs` / `examMatSubjs` / `examSciSubjs` — mode predicates + subject lists. Subject arrays live in the `*_SUBJS` consts; don't re-inline them.

Wide tables (many exam columns) use `class="tw tw-cards tw-wide"`. `.tw-wide` sets `min-width:max-content` + `white-space:nowrap` so the table **scrolls horizontally instead of crushing 이름/학교 into multi-line cells**, and pins the first three columns (좌석·학년·이름) with `position:sticky` so rows stay identifiable while scrolling. The `@media(max-width:640px)` card mode resets all of that. Off-grade exam cells also get `cell-hide`, which does nothing on desktop but removes the row of `—` entries from mobile cards.

`gcRelGroups(exam)` derives the 등급컷 table from these, so both cut modals (`openExamGradeCuts`, `openEstGradeCuts`) adapt automatically. Note that saving a cut modal rebuilds `gradeCuts` from only the currently-visible subjects — switching a mode and re-saving cuts discards the old mode's cuts.

`saveExamScore` (the `es-*` ids) is dead code from the pre-wizard student form; the live student path is `startScoreWizard` → `getScoreSteps` → `finishScoreWizard`.

### Contact button

The 채널톡 (ChannelIO) launcher was removed on 2026-09-02 and replaced by `#kakaoCh`, a plain anchor to the academy's KakaoTalk channel, styled as a floating launcher in the same corner — deliberately kept in ChannelIO's pastel-blue chat-bubble look rather than Kakao yellow, so it reads as part of the app. `applyChannelIOVisibility` (name kept, call sites unchanged) sets its `href` and toggles `.on`: shown for students and logged-out visitors, hidden for admin/operator/tablet — and hidden whenever no URL is configured. The URL comes from `config.kakaoChannelUrl` in Firestore, falling back to the `KAKAO_CHANNEL_URL` constant (currently the `/chat` deep link for channel `_MtGCX`). `showView` re-applies it on every view change, so paths that skip `enterHome` still get the right state.

### Answer keys (정답표 · 가채점)

Optional per exam. When an exam has an answer key for a subject, the student's wizard replaces the 원점수 field with a 문항별 답안 sheet and scores it automatically.

- `exam.answerKeys[과목명] = {items:[{a:'정답', p:배점}, …]}`. The subject key follows the same rule as `gradeCuts` (공통형 → `'국어'`/`'수학'`, 통합탐구 → the fixed names), so 국어/수학 선택과목마다 별도 정답표를 등록합니다.
- **`a` decides the input type**: `1`–`5` renders 5지선다 buttons, anything else (a 단답형 number) renders a text field. There is no separate flag — `akIsChoice` is the single check.
- Scoring lives in `akScore` / `akWrongNos` / `akUnanswered`, all driven by `items` (not by the student's array length), so a short or missing answer array just counts as 미입력.
- **The student sheet is a 가채점표, not a button grid**: `akSheetSections` splits the key at `answerKeys[subj].common` (문항 수 of the 공통 과목 block, `0` = no split) into 공통과목 / 선택과목(과목명), then `akSheetBlocks` walks each section splitting on 객관식/주관식 runs — 객관식 is chunked **5문항 per input** (`swBlockInput`, accepts only `1`–`5`, auto-advances when full), 주관식 gets one box per 문항 (`swShortInput`). `common` is filled automatically by the PDF import and is editable in the 정답표 modal.
- `getScoreSteps` reads `S.scoreWizard` to decide: for 선택과목 subjects the answer sheet step is inserted *after* the subject-picking step and only once a subject with a key is chosen (that step gets `hideRaw`). Changing the 선택과목 changes the step list — that is why `finishScoreWizard` calls **`swSyncAnswerRaws`** to recompute every raw from the answers against the *currently* selected subjects. The live `swUpdateSheetScore` only updates the step being viewed, so it alone is not enough.
- Saved as `scores[examId].answers = {kor:[…], mat:[…], …}`, padded to the key's question count, only for subjects that have a key. Raw/grade fields stay exactly as before, so 등급·그래프·성적표 needed no changes.
- 제2외국어/한문 has no answer-sheet support (still 원점수), and the **admin** score form always edits raw directly — that is the override path.

**KICE PDF import.** `cdn.kice.re.kr` serves the official 정답표 PDFs with `Access-Control-Allow-Origin: *`, so the browser fetches and parses them directly — **no Cloud Function or proxy is needed**; don't add one. `getPdfjs()` lazy-loads pdf.js from jsdelivr (same CDN as the font) and `akParseKice` turns its positioned text items into per-subject keys:

- Rows are clustered by `y`; a data row is one whose tokens are all digits or ①–⑤ and whose count is a multiple of 3 — each triple is (문항번호, 정답, 배점).
- **공통 문항 appear once, 선택 문항 repeat once per 선택과목.** The repeat count gives the number of subject columns; the subject names come from the header row (matched against `akAllKnownSubjs()`) and are paired to occurrences by `x` order. The number of once-only 문항 becomes `common`. Single-column PDFs (영어/한국사) fall back to the `… 영역 정답표` title and get `common: 0`.
- Verified end-to-end against the live 2027 9월 모평 `_1a`/`_2a`: 국어 화작·언매 45문항, 수학 확통·미적·기하 30문항, 배점합 100 each, 단답형 answers (`190`, `457`, …) intact.
- URL pattern is `…/{코드}/{코드}_{교시}a.pdf` (1 국어, 2 수학, 3 영어 …), published progressively through exam day. The last-used URL is kept in `exam.answerKeySrc`. Only 국어/수학 PDFs existed when this was written — 영어/한국사/탐구 layouts are handled by the same generic rule but were never seen, so the import fills the grid and the admin confirms before 저장.

### Notices vs. popups

Two separate things, both admin-managed from the **공지사항** tab:

- **`notices`** — the always-visible 공지사항 card on the student 멘토링 page. `{body, pinned, createdAt, …}`; kept in sync by an `onSnapshot` listener, so the CRUD handlers write to Firestore only and let the listener update `S.notices` and re-render (writing locally too produces duplicates).
- **`popups`** — a modal that appears once per visit to the **home hub** (`enterHome`), for everyone including admins. `{title, body, startDate, endDate, enabled, createdAt, …}`; dates are `YYYY-MM-DD` and either end may be empty (open-ended). Loaded on demand via `loadPopups()` (a plain `get()`, no listener) and re-fetched after every write, so popup CRUD *does* update `S.popups` locally.

Popup specifics:

- The body is plain text the admin types, but `popupBodyHtml` splits it into 문단 `<p>` blocks and — for consecutive lines starting with `·`/`-`/`※` — a highlighted `.pp-note` list, so a bare textarea still renders as a designed notice. Indented continuation lines fold into the preceding item. Everything goes through `escapeHtml`; never render popup body as raw HTML.
- `popupActive(p)` gates display; `popupStatus(p)` maps the same state to the 노출중/예정/종료/중지 chip in the admin list.
- Multiple active popups queue up (`_popupQueue`, newest first) and advance on 닫기.
- **오늘 하루 보지 않기 is `localStorage` only** — key `popupHide_<docId>` holding a date string. Nothing is written to Firestore, so it is per-browser and resets at midnight. Never "fix" this by storing dismissals per student.
- `S.popupShown` makes the popup fire once per session; `doLogout` resets it (and `_popupsLoaded`) so the next login shows it again.
- The sample 팝업 is seeded once by `popupSeedSample()` when an admin first opens the 공지사항 tab, guarded by `config.popupSeeded`. Deleting the sample must not bring it back — that flag is the guard, so don't seed off an empty-collection check.

### Printing (예약 현황)

`window.print()` is only ever called from `doBookPrint`. Printing is **opt-in isolation**, not opt-out:

- The print document is rendered into `#printRoot`, a **direct child of `<body>`** — not into the booking view. `doBookPrint` adds `body.printing`, and `@media print` then hides every body child except `#printRoot` (`body.printing>*{display:none!important}` + an ID-specificity override). The earlier approach only hid `.np`-tagged blocks, so the slot grid, requests section and no-show section printed underneath the print area.
- `endBookPrint` (bound to `afterprint`, plus a `focus` fallback for browsers that skip it) drops the class and empties `#printRoot`.
- `buildBookingPrintHtml` emits `.pr-*` classes only — no inline styling. Those classes are defined for screen (the modal preview at `#printPrev` uses the same markup) and re-sized inside `@media print`, so preview and paper stay in sync. Add print styling there, never as inline styles in the builder.

### Grade-cut model (graph/score rendering)

A student's score per exam is stored with both a `*Raw` (raw score) and a cached `*Grade` (computed grade) for each subject (`kor`, `mat`, `eng`, `his`, `exp1`, `exp2`, `lang2`), plus optional `*GradeOverride` for admin overrides. Exams carry two parallel cut tables:

- `exam.gradeCuts[subj]` — array of confirmed thresholds (one per grade band). Used by `calcGrade`.
- `exam.estGradeCuts[subj]` — array of `{lo, hi}` ranges for "예상 등급컷". Used by `calcEstGrade`, which returns either a single grade or a `"best-worst"` range string.

`getExamGrade` prefers `gradeCuts` over `estGradeCuts`. The cached `*Grade` field does **not** carry estimated-vs-actual provenance — UI code must call `isEstGrade(exam, subj)` against the *current* exam state to decide styling/branching (see `examGradeCell`, `drawGradeGraph`). Partial cut entries (empty slot in `gradeCuts`, only `lo` or only `hi` in `estGradeCuts`) are tolerated at runtime — see `ecNorm` for mirroring logic.

## Common commands

```bash
# Functions: install + deploy
cd functions && npm install && cd ..
firebase deploy --only functions --project consulting-dd53f

# Firestore rules only
firebase deploy --only firestore:rules --project consulting-dd53f

# Functions logs
cd functions && npm run logs

# Mobile: build + open Xcode/Studio
cd mobile && npm run ios     # builds www/ and opens iOS project
cd mobile && npm run android

# Local web preview — any static server in the repo root works; there is no bundler.
# Firestore writes go to the live project, so test with care.
```

There are **no automated tests, linters, or build steps** for the web app. `index.html` is served as-is by Vercel.

## Conventions and quirks

- **UI language is Korean.** User-facing strings, comments, and commit messages are in Korean. Don't translate them.
- The product was renamed **컨설팅 → 멘토링** on 2026-05-07 in user-facing strings, but the GitHub repo name, Firebase project, and many internal identifiers (`consultStuId`, `renderAdminConsult`, etc.) still say "consulting" / "consult". Don't rename these.
- **No comments unless the *why* is non-obvious.** Existing code follows this — match it. Never add narration comments like "// render the list" or "// added for the est-grade fix."
- `index.html` is intentionally dense (multi-statement lines, minimal whitespace). When editing, match the local style rather than reformatting surrounding code.
- Alimtalk template texts live in `alimtalk-templates.txt` for reference; the live versions are stored under `settings/ppurio.templates` in Firestore.

## Useful entry points when starting a task

- **Score/grade logic**: `calcGrade`, `calcEstGrade`, `getExamGrade`, `isEstGrade`, `examGradeCell`, `getGradeSubjects`, `drawGradeGraph` in `index.html`.
- **Consulting flow (booking/request)**: `renderAdminConsult`, `renderConsultDetail`, `onBookingCreate`/`onRequestCreate`/`onRequestUpdate` in `functions/index.js`.
- **Alimtalk send path**: `functions/index.js` → `sendAlimtalk` in `functions/ppurio.js` → vm-proxy → ppurio API.
- **Admin settings**: `ppurioAdmin` (Cloud Function) and the settings tab handlers in `index.html` (search `ppurioAdmin` to find both sides).
