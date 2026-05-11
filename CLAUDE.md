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
- **Mobile app** — `cd mobile && npm run ios` (or `android`). Only needed for App/Play Store releases; not part of the web deploy flow.

Firebase project: **`consulting-dd53f`** (set as `default` in `.firebaserc`).

When the user wants a frontend change live, commit + push and trust Vercel. Don't try `firebase deploy --only hosting`.

### Security boundary

`firestore.rules` allows read/write to all collections **except `settings/*`**. The ppurio API key, account, sender profile, and admin phone list live in `settings/ppurio`. Anything touching credentials must go through Cloud Functions (Admin SDK) — never read or write `settings/*` from `index.html`. The admin UI's settings tab calls `ppurioAdmin` over HTTP.

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
