"use strict";

/**
 * 자유게시판 제재.
 *
 * 제재는 한 종류뿐이다 — **영구 이용정지**. 기간제 정지를 두면 며칠을 줄지
 * 매번 판단해야 하고 만료 시점 처리도 필요해진다. 규칙 위반이면 영구,
 * 잘못 처리했으면 해제, 이 둘로만 간다.
 *
 * 제재 기록을 students 문서에 두면 students 가 클라이언트 쓰기 개방이라
 * 정지당한 학생이 스스로 지울 수 있다. 그래서 `boardBans/{studentId}` 라는
 * 서버 전용 컬렉션에 두고 여기(= tokenApi)서만 쓴다. 읽기는 열어 둬
 * 클라이언트가 onSnapshot 으로 정지 여부를 바로 반영한다.
 *
 * 문서 형태: { banned, reason, byId, byName, updatedAt,
 *              history:[{type:'ban'|'unban', reason, byId, byName, ts, post?}] }
 */

const { ApiError } = require("./tokens");

const MAX_HISTORY = 50;
const EVIDENCE_TITLE_MAX = 120;
const EVIDENCE_BODY_MAX = 500;

/* 지우기 전의 글을 정지 이력에 박아 둔다. 근거가 된 글이 사라지면
   "난 그런 글 쓴 적 없다"에 아무것도 내놓을 수 없다. */
function postEvidence(id, d) {
  return {
    id,
    title: String(d.title || "").slice(0, EVIDENCE_TITLE_MAX),
    body: String(d.body || "").slice(0, EVIDENCE_BODY_MAX),
    photos: Array.isArray(d.photos) ? d.photos.length : 0,
    createdAt: d.createdAt || 0,
  };
}

function isBanned(ban) {
  return !!(ban && ban.banned === true);
}

function pushHistory(cur, entry) {
  return [...(Array.isArray(cur.history) ? cur.history : []), entry].slice(-MAX_HISTORY);
}

/**
 * 영구 이용정지. 정지 사유가 된 글(`postId`)은 같은 트랜잭션에서 지운다 —
 * 이용 서약이 "글이 삭제되고 이용이 정지된다"고 약속하므로 둘이 따로 놀면 안 된다.
 * 클라이언트가 지우게 두면 정지만 되고 글은 남는 절반짜리 상태가 생긴다.
 * 사진은 Storage 라 문서와 함께 지울 수 없어 호출한 쪽이 이어서 지운다.
 */
async function banBoard(fs, { studentId, reason, by, postId }) {
  if (!studentId) throw new ApiError(400, "학생을 선택해 주세요.");
  const r = String(reason || "").trim();
  if (!r) throw new ApiError(400, "사유를 입력해 주세요.");

  const now = Date.now();
  const ref = fs.doc(`boardBans/${studentId}`);
  const postRef = postId ? fs.doc(`posts/${postId}`) : null;
  return fs.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const postSnap = postRef ? await tx.get(postRef) : null;
    const cur = snap.exists ? snap.data() : {};
    if (cur.banned === true) throw new ApiError(409, "이미 이용정지된 학생입니다.");
    /* 남의 글을 지우지 않도록 작성자를 확인한다 — 화면은 그 글 작성자를 정지하는 자리지만
       payload 가 어긋나면 엉뚱한 글이 사라진다. */
    const post = postSnap && postSnap.exists && postSnap.data().authorId === studentId
      ? postSnap.data() : null;
    const entry = {
      type: "ban", reason: r,
      byId: (by && by.id) || "", byName: (by && by.name) || "", ts: now,
    };
    if (post) entry.post = postEvidence(postId, post);
    tx.set(ref, {
      banned: true,
      reason: r,
      byId: entry.byId,
      byName: entry.byName,
      updatedAt: now,
      history: pushHistory(cur, entry),
    }, { merge: true });
    if (post) tx.delete(postRef);
    return { banned: true, postDeleted: !!post };
  });
}

/** 정지 해제. 이력은 남긴다 — 왜 풀렸는지가 사라지면 안 된다. */
async function unbanBoard(fs, { studentId, reason, by }) {
  if (!studentId) throw new ApiError(400, "학생을 선택해 주세요.");
  const now = Date.now();
  const ref = fs.doc(`boardBans/${studentId}`);
  return fs.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : {};
    if (cur.banned !== true) throw new ApiError(409, "이용정지 상태가 아닙니다.");
    const entry = {
      type: "unban",
      reason: String(reason || "").trim() || "정지 해제",
      byId: (by && by.id) || "", byName: (by && by.name) || "", ts: now,
    };
    tx.set(ref, {
      banned: false,
      updatedAt: now,
      history: pushHistory(cur, entry),
    }, { merge: true });
    return { banned: false };
  });
}

/* ── 이용 서약 ──
   본인이 지울 수 있는 곳에 두면 "동의한 적 없다"가 되어 제재 근거가 흔들린다.
   그래서 boardPledges 도 서버 전용이다. 규칙 문구가 바뀌면 version 을 올려 다시 받는다. */
async function agreePledge(fs, { studentId, version, name }) {
  if (!studentId) throw new ApiError(400, "학생 정보가 없습니다.");
  const v = String(version || "").trim();
  if (!v) throw new ApiError(400, "서약 버전이 없습니다.");
  const now = Date.now();
  const ref = fs.doc(`boardPledges/${studentId}`);
  const snap = await ref.get();
  const cur = snap.exists ? snap.data() : {};
  const history = [...(Array.isArray(cur.history) ? cur.history : []), { version: v, ts: now }].slice(-MAX_HISTORY);
  await ref.set({ version: v, agreedAt: now, name: String(name || ""), history }, { merge: true });
  return { version: v, agreedAt: now };
}

async function getPledge(fs, studentId) {
  const snap = await fs.doc(`boardPledges/${studentId}`).get();
  return snap.exists ? snap.data() : null;
}

async function getBan(fs, studentId) {
  const snap = await fs.doc(`boardBans/${studentId}`).get();
  return snap.exists ? snap.data() : null;
}

module.exports = { isBanned, banBoard, unbanBoard, getBan, agreePledge, getPledge };
