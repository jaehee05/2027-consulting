"use strict";

/**
 * 알림톡 발송 서비스 레이어.
 *
 * ppurio.js 는 "한 건 보낸다"만 하고, 여기서 그 위에 업무 규칙을 얹는다.
 *   - 변수 검증: 빈 값이 하나라도 있으면 보내지 않는다. 빈 변수로 나가면 심사 위반이 된다.
 *   - 재시도: 최대 3회, 지수 백오프.
 *   - 로그: 성공이든 실패든 alimtalkLogs 에 남긴다.
 *   - 드라이런: 개발/스테이징에서는 실제로 보내지 않고 로그만 남긴다.
 *
 * 호출부(토큰 충전·질문 등록 등)는 이 모듈을 **트랜잭션이 커밋된 뒤에** 부르고,
 * 반환된 Promise 를 기다리지 않는다. 알림톡이 실패해도 본 기능은 이미 끝나 있어야 한다.
 */

const admin = require("firebase-admin");
const { sendAlimtalk, sendAlimtalkToAdmins } = require("./ppurio");

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500; // 500ms → 1s → 2s
const LOG_COLLECTION = "alimtalkLogs";

/* ── 유틸 ── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cloud Functions 는 UTC 로 돈다. 문자로 찍을 때는 한국 시각으로. */
function kstStamp(ts) {
  const d = new Date(typeof ts === "number" ? ts : Date.now());
  const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}

function won(n) {
  return `${Math.round(Number(n) || 0).toLocaleString("ko-KR")}원`;
}

/** 로그에 원문 번호를 그대로 남기지 않는다. */
function maskPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  if (d.length < 7) return d ? "***" : "";
  return `${d.slice(0, 3)}****${d.slice(-4)}`;
}

/**
 * 빈 변수 검사. null / undefined / 공백뿐인 문자열을 모두 잡는다.
 * 숫자 0 은 유효한 값이다("보유 토큰 0개"는 정상) — 0 을 빈 값으로 보면 안 된다.
 */
function findEmptyVars(vars) {
  return Object.entries(vars)
    .filter(([, v]) => v === null || v === undefined || String(v).trim() === "")
    .map(([k]) => k);
}

function isDryRun() {
  return process.env.ALIMTALK_DRY_RUN === "1" || process.env.ALIMTALK_DRY_RUN === "true";
}

/* ── 로그 ── */

async function writeLog(entry) {
  try {
    await admin.firestore().collection(LOG_COLLECTION).add({
      eventKey: entry.eventKey,
      templateCode: entry.templateCode || "",
      recipientType: entry.recipientType,          // 'student' | 'admins'
      recipient: maskPhone(entry.recipient),
      recipientName: entry.recipientName || "",
      vars: entry.vars || {},
      status: entry.status,                        // 'sent' | 'failed' | 'skipped' | 'dryrun'
      responseCode: entry.responseCode ?? null,
      error: entry.error || "",
      attempts: entry.attempts || 0,
      sentAt: Date.now(),
    });
  } catch (e) {
    // 로그를 못 남긴다고 발송을 실패로 만들 이유는 없다.
    console.error("[notify] 발송 로그 기록 실패:", e);
  }
}

/** 뿌리오 응답에서 코드만 뽑는다. 응답 형태가 바뀌어도 로그가 깨지지 않게 방어적으로. */
function responseCodeOf(res) {
  if (!res || typeof res !== "object") return null;
  return res.code ?? res.resultCode ?? res.status ?? null;
}

/* ── 발송 ── */

async function sendWithRetry(fn, eventKey) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return { result: await fn(), attempts: attempt };
    } catch (err) {
      lastErr = err;
      console.warn(`[notify:${eventKey}] ${attempt}/${MAX_ATTEMPTS}회 발송 실패: ${err.message || err}`);
      if (attempt < MAX_ATTEMPTS) await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }
  const e = new Error(lastErr?.message || String(lastErr));
  e.attempts = MAX_ATTEMPTS;
  throw e;
}

/**
 * 알림톡 한 건(또는 관리자 전원). 절대 throw 하지 않는다 — 호출부는 결과를 기다리지 않는다.
 * @param {'student'|'admins'} to
 * @param {object} vars changeWord 로 들어갈 값. 하나라도 비면 발송하지 않는다.
 */
async function notify(eventKey, { to, phone, name, vars }) {
  const empty = findEmptyVars(vars || {});
  if (empty.length) {
    const msg = `필수 변수 누락: ${empty.join(", ")}`;
    console.error(`[notify:${eventKey}] ${msg} — 발송하지 않음`);
    await writeLog({ eventKey, recipientType: to, recipient: phone, recipientName: name, vars, status: "skipped", error: msg });
    return;
  }
  if (to === "student") {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!digits) {
      const msg = "학생 연락처 없음";
      console.error(`[notify:${eventKey}] ${msg} (${name}) — 발송하지 않음`);
      await writeLog({ eventKey, recipientType: to, recipient: "", recipientName: name, vars, status: "skipped", error: msg });
      return;
    }
  }

  if (isDryRun()) {
    console.log(`[notify:${eventKey}] DRY RUN — 실제 발송 없음`, JSON.stringify({ to, phone: maskPhone(phone), name, vars }));
    await writeLog({ eventKey, recipientType: to, recipient: phone, recipientName: name, vars, status: "dryrun" });
    return;
  }

  const ctx = { ...vars, name: name || "", phone };
  try {
    const { result, attempts } = await sendWithRetry(
      () => (to === "admins" ? sendAlimtalkToAdmins(eventKey, ctx) : sendAlimtalk(eventKey, ctx)),
      eventKey
    );
    const skipped = result && result.skipped;
    await writeLog({
      eventKey, recipientType: to, recipient: phone, recipientName: name, vars,
      status: skipped ? "skipped" : "sent",
      responseCode: skipped ? null : responseCodeOf(result),
      error: skipped ? String(skipped) : "",
      attempts,
    });
  } catch (err) {
    console.error(`[notify:${eventKey}] 최종 발송 실패:`, err);
    await writeLog({
      eventKey, recipientType: to, recipient: phone, recipientName: name, vars,
      status: "failed", error: String(err.message || err), attempts: err.attempts || MAX_ATTEMPTS,
    });
  }
}

/* ── 트리거별 진입점 ──
   전부 fire-and-forget 이다. 호출부는 await 하지 않는다. */

/**
 * 1. 토큰 충전 완료 — 학생에게만.
 * var1 이번 충전 수량 / var2 충전 후 보유 토큰
 */
function notifyTokenCharged({ studentName, phone, charged, balance }) {
  return notify("tokenCharged", {
    to: "student", phone, name: studentName,
    vars: { var1: `${charged}개`, var2: `${balance}개` },
  });
}

/**
 * 2. 토큰 결제 요청 접수 — 관리자에게.
 * var1~3 이름/학교/학년, var4 요청 수량, var5 결제 금액, var6 요청 일시
 */
function notifyTokenPaymentRequested({ studentName, school, grade, tokens, amount, requestedAt }) {
  return notify("adminNotifyTokenRequest", {
    to: "admins", name: studentName,
    vars: {
      var1: studentName, var2: school, var3: grade,
      var4: `${tokens}개`, var5: won(amount), var6: kstStamp(requestedAt),
    },
  });
}

/**
 * 3. 새 질문 등록 — 관리자에게.
 * var1 학생 이름, var2 등록 일시, var3 미답변 스레드 수, var4 전체 스레드 누적 수
 *
 * var3 은 **전체 학생 기준** 미답변 스레드 수다(해당 학생 것만이 아니다).
 * 관리자에게 "지금 답변해야 할 일이 몇 건 남았는지"를 알리는 숫자이기 때문이다.
 */
async function notifyQuestionCreated({ studentName, createdAt }) {
  const fs = admin.firestore();
  let pending = 0, total = 0;
  try {
    const [p, t] = await Promise.all([
      fs.collection("questions").where("status", "==", "pending").count().get(),
      fs.collection("questions").count().get(),
    ]);
    pending = p.data().count;
    total = t.data().count;
  } catch (e) {
    console.error("[notify:adminNotifyQuestionCreated] 스레드 수 집계 실패:", e);
    // 집계에 실패하면 0 이 들어가 사실과 다른 숫자가 나간다. 차라리 보내지 않는다.
    await writeLog({
      eventKey: "adminNotifyQuestionCreated", recipientType: "admins", recipientName: studentName,
      vars: {}, status: "skipped", error: `스레드 수 집계 실패: ${e.message || e}`,
    });
    return;
  }
  return notify("adminNotifyQuestionCreated", {
    to: "admins", name: studentName,
    vars: { var1: studentName, var2: kstStamp(createdAt), var3: String(pending), var4: String(total) },
  });
}

/**
 * 4. 관리자 답변 등록 — 질문을 쓴 학생에게.
 * var1 질문 제목, var2 답변 등록 일시
 *
 * 관리자가 댓글을 달 때마다 보낸다(첫 답변만이 아니다). 답변 뒤 24시간이 지나면
 * 스레드가 자동으로 닫히므로, 학생이 그 사이에 이어 물을 수 있으려면 매번 알아야 한다.
 * 제목은 템플릿 한 줄에 들어가야 해서 잘라 보낸다.
 */
function notifyQuestionAnswered({ studentName, phone, title, answeredAt }) {
  const t = String(title || "").trim();
  return notify("questionAnswered", {
    to: "student", phone, name: studentName,
    vars: { var1: t.length > 30 ? `${t.slice(0, 30)}…` : t, var2: kstStamp(answeredAt) },
  });
}

module.exports = {
  notify,
  notifyTokenCharged,
  notifyTokenPaymentRequested,
  notifyQuestionCreated,
  notifyQuestionAnswered,
  // 테스트용
  findEmptyVars, kstStamp, won, maskPhone, MAX_ATTEMPTS, LOG_COLLECTION,
};
