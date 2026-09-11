"use strict";

/**
 * 관리자 앱 푸시(FCM).
 *
 * 알림톡(notify.js)과 나란히 서는 두 번째 알림 경로다. 알림톡은 학생·보호자에게,
 * 푸시는 **관리자 본인 폰**에 보낸다 — 관리자가 알림톡을 받아 보면 건당 비용이 나가고,
 * 무엇보다 "지금 답해야 할 게 생겼다"는 신호는 앱을 열어 처리하는 흐름이라야 한다.
 *
 * 토큰은 `pushTokens/{token}` 한 문서에 하나씩 둔다. 관리자 문서 안 배열로 두면
 * 같은 기기를 두 계정으로 쓰거나 토큰이 갱신될 때 지우지 못한 값이 쌓인다.
 * 문서 id 가 곧 토큰이므로 같은 기기가 다시 등록해도 덮어써질 뿐 늘어나지 않는다.
 *
 * 이 컬렉션은 `firestore.rules` 에서 읽기까지 막혀 있다. 토큰은 그 기기로 알림을
 * 보낼 수 있는 자격증명이라 남이 읽을 이유가 없다. 등록·삭제는 tokenApi 를 거친다.
 */

const admin = require("firebase-admin");

const COLLECTION = "pushTokens";
const SEND_LIMIT = 500; // sendEachForMulticast 한 번에 보낼 수 있는 최대치

/** 토큰 등록. 같은 토큰이 다시 오면 덮어쓴다(기기 하나 = 문서 하나). */
async function registerToken(fs, { token, platform, actor }) {
  const t = String(token || "").trim();
  if (!t) return { ok: false, reason: "no-token" };
  await fs.collection(COLLECTION).doc(t).set({
    token: t,
    platform: String(platform || "").slice(0, 20),
    role: actor.role,
    ownerId: actor.id || "",
    ownerName: actor.name || "",
    updatedAt: Date.now(),
  }, { merge: true });
  return { ok: true };
}

/** 로그아웃·알림 끄기. 실패해도 조용히 넘어간다 — 지우지 못한 토큰은 발송 때 어차피 걸러진다. */
async function unregisterToken(fs, { token }) {
  const t = String(token || "").trim();
  if (!t) return { ok: false, reason: "no-token" };
  await fs.collection(COLLECTION).doc(t).delete().catch(() => {});
  return { ok: true };
}

/**
 * 관리자 전원에게 한 건. **절대 throw 하지 않는다** — 호출부는 트랜잭션이 끝난 뒤
 * 기다리지 않고 부르고, 푸시가 실패했다고 질문 등록이 되돌아가면 안 된다.
 *
 * 죽은 토큰(앱 삭제·재설치)은 응답으로만 알 수 있으므로 그 자리에서 지운다.
 * 안 지우면 매번 같은 실패를 반복하고 로그가 쓸모없어진다.
 */
async function pushToAdmins(fs, { title, body, data }) {
  try {
    const snap = await fs.collection(COLLECTION).where("role", "==", "admin").limit(SEND_LIMIT).get();
    if (snap.empty) return { sent: 0, skipped: "no-tokens" };
    const tokens = snap.docs.map((d) => d.id);
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      // 값은 전부 문자열이어야 한다 — 숫자를 넣으면 전송 자체가 거부된다.
      data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v ?? "")])),
      apns: { payload: { aps: { sound: "default" } } },
      android: { priority: "high", notification: { sound: "default" } },
    });
    const dead = [];
    res.responses.forEach((r, i) => {
      const code = r.error && r.error.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-argument") {
        dead.push(tokens[i]);
      }
    });
    await Promise.all(dead.map((t) => fs.collection(COLLECTION).doc(t).delete().catch(() => {})));
    if (res.failureCount) {
      console.warn(`[push] ${res.successCount}건 성공 / ${res.failureCount}건 실패, 죽은 토큰 ${dead.length}개 정리`);
    }
    return { sent: res.successCount, failed: res.failureCount, pruned: dead.length };
  } catch (e) {
    console.error("[push] 발송 실패:", e);
    return { sent: 0, error: String((e && e.message) || e) };
  }
}

/* ── 상황별 진입점 ──
   문구는 잠금화면에서 두 줄 안에 읽히는 길이로 맞춘다. 자세한 내용은 앱을 열면 있다. */

function pushQuestionCreated({ studentName, title, questionId }) {
  return pushToAdmins(admin.firestore(), {
    title: "새 질문이 등록됐습니다",
    body: `${studentName} · ${title}`,
    data: { view: "qa", sub: "q", questionId },
  });
}

/** 답변완료 스레드에 학생이 다시 댓글을 달았을 때. 답변대기로 돌아가지 않아 목록만 봐서는 놓친다. */
function pushQuestionFollowUp({ studentName, title, questionId }) {
  return pushToAdmins(admin.firestore(), {
    title: "추가 질문이 달렸습니다",
    body: `${studentName} · ${title}`,
    data: { view: "qa", sub: "q", questionId },
  });
}

function pushPaymentRequested({ studentName, tokens, amount }) {
  return pushToAdmins(admin.firestore(), {
    title: "토큰 결제 요청",
    body: `${studentName} · ${tokens}토큰 ${Math.round(Number(amount) || 0).toLocaleString("ko-KR")}원`,
    data: { view: "qa", sub: "p" },
  });
}

module.exports = {
  COLLECTION,
  registerToken,
  unregisterToken,
  pushToAdmins,
  pushQuestionCreated,
  pushQuestionFollowUp,
  pushPaymentRequested,
};
