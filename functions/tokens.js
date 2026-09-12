"use strict";

/**
 * 토큰 · 질문게시판 · 결제 요청의 모든 상태 변경.
 *
 * 여기 있는 함수는 firestore 인스턴스를 인자로 받는다. Cloud Function 런타임에
 * 묶여 있지 않아야 에뮬레이터에서 그대로 테스트할 수 있기 때문이다.
 * 토큰이 오가는 모든 경로는 예외 없이 runTransaction 안에서 잔액을 읽고 쓴다.
 */

const POLICY_DOC = "config/tokens";

const DEFAULT_POLICY = {
  signupGrant: 1,
  questionCost: 1,
  unitPrice: 1000,
  packages: [],
  // 결제 수단. 결제선생은 관리자가 알림톡으로 링크를 보내고, 계좌이체는 학생이 직접 입금한다.
  ppurioEnabled: true,
  bankEnabled: false,
  bankName: "",
  bankAccount: "",
  bankHolder: "",
  // 답변이 달린 스레드를 마지막 활동으로부터 몇 시간 뒤에 자동 종료할지. 0 이면 끈다.
  questionIdleHours: 24,
};
const IDLE_HOURS_MAX = 24 * 7;
const PAY_METHODS = ["ppurio", "bank"];

const LEDGER_REASONS = ["signup", "question", "purchase", "manual"];
const PR_STATUS = ["requested", "sent", "paid", "canceled"];
const Q_STATUS = ["pending", "answered", "closed"];

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function num(v, dflt = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

async function getPolicy(fs) {
  const snap = await fs.doc(POLICY_DOC).get();
  const raw = snap.exists ? snap.data() : {};
  return {
    signupGrant: Math.max(0, Math.floor(num(raw.signupGrant, DEFAULT_POLICY.signupGrant))),
    questionCost: Math.max(0, Math.floor(num(raw.questionCost, DEFAULT_POLICY.questionCost))),
    unitPrice: Math.max(0, Math.floor(num(raw.unitPrice, DEFAULT_POLICY.unitPrice))),
    packages: Array.isArray(raw.packages) ? raw.packages : [],
    ppurioEnabled: raw.ppurioEnabled !== false,
    bankEnabled: raw.bankEnabled === true,
    bankName: String(raw.bankName || ""),
    bankAccount: String(raw.bankAccount || ""),
    bankHolder: String(raw.bankHolder || ""),
    questionIdleHours: clampIdleHours(raw.questionIdleHours, DEFAULT_POLICY.questionIdleHours),
  };
}

function clampIdleHours(v, dflt) {
  return Math.min(IDLE_HOURS_MAX, Math.max(0, Math.floor(num(v, dflt))));
}

/**
 * 자동 종료 판정.
 *
 * **답변이 달린 스레드만 닫는다.** 미답변 스레드까지 닫으면 관리자가 주말에 늦게
 * 답하는 동안 학생이 토큰만 쓰고 스레드가 사라진다 — 환불 규정상 스레드를 연
 * 순간 환불이 안 되므로 그건 그냥 손해다. 시계는 관리자가 답한 뒤부터 돈다.
 *
 * 기준 시각은 `updatedAt` — 댓글·수정·삭제가 전부 이 값을 올리므로 "마지막 활동"이다.
 */
function idleDeadline(q, hours) {
  if (!q || q.status !== "answered" || !hours) return 0;
  const last = q.updatedAt || q.createdAt || 0;
  return last ? last + hours * 3600000 : 0;
}

function isIdle(q, hours, now) {
  const due = idleDeadline(q, hours);
  return !!due && now >= due;
}

/** 자동 종료로 남기는 값. `closedReason` 이 있어야 화면이 "관리자가 닫음"과 다른 안내를 낼 수 있다. */
function idleCloseUpdate(now) {
  return {
    status: "closed", updatedAt: now, closedAt: now,
    closedReason: "idle", closedById: "", closedByName: "",
  };
}

/** 계좌이체를 켜 두려면 은행·계좌·예금주가 다 있어야 한다. 하나라도 비면 켜 봐야 학생이 입금할 수 없다. */
function bankReady(policy) {
  return !!(policy.bankEnabled && policy.bankName && policy.bankAccount && policy.bankHolder);
}

/** 정가 − 할인. 할인이 정가를 넘어도 0원 아래로는 내려가지 않는다. */
function packagePrice(pkg, unitPrice) {
  const tokens = Math.max(0, Math.floor(num(pkg && pkg.tokens)));
  const list = tokens * Math.max(0, Math.floor(num(unitPrice)));
  const type = pkg && pkg.discountType;
  const value = Math.max(0, num(pkg && pkg.discountValue));
  let discount = 0;
  if (type === "percent") discount = Math.floor((list * Math.min(value, 100)) / 100);
  else if (type === "amount") discount = Math.floor(value);
  discount = Math.min(discount, list);
  return { tokens, list, discount, amount: Math.max(0, list - discount) };
}

function normalizePackages(raw, unitPrice) {
  return (Array.isArray(raw) ? raw : [])
    .map((p, i) => {
      const price = packagePrice(p, unitPrice);
      // 보너스는 값을 깎지 않고 토큰을 더 얹는다. 금액 계산에는 들어가지 않는다.
      const bonus = Math.max(0, Math.floor(num(p.bonus)));
      return {
        id: String(p.id || `pkg_${i}`),
        tokens: price.tokens,
        bonus,
        totalTokens: price.tokens + bonus,
        active: p.active !== false,
        order: Math.floor(num(p.order, i)),
        discountType: ["percent", "amount"].includes(p.discountType) ? p.discountType : "none",
        discountValue: Math.max(0, num(p.discountValue)),
        listPrice: price.list,
        discount: price.discount,
        amount: price.amount,
      };
    })
    .sort((a, b) => a.order - b.order);
}

/* ── 잔액 · 원장 ──
   원장은 잔액을 바꾼 트랜잭션 안에서만 쓴다. 따로 쓰면 둘이 어긋난다. */

function ledgerEntry(tx, fs, { studentId, delta, reason, refId, balanceAfter, note, by, now }) {
  if (!LEDGER_REASONS.includes(reason)) throw new ApiError(500, `알 수 없는 사유: ${reason}`);
  const ref = fs.collection("tokenLedger").doc();
  tx.set(ref, {
    studentId,
    delta,
    reason,
    refId: refId || "",
    balanceAfter,
    note: note || "",
    byId: (by && by.id) || "",
    byName: (by && by.name) || "",
    createdAt: now,
  });
  return ref;
}

async function readBalance(tx, fs, studentId) {
  const ref = fs.doc(`tokenBalances/${studentId}`);
  const snap = await tx.get(ref);
  return { ref, balance: snap.exists ? Math.floor(num(snap.data().balance)) : 0, exists: snap.exists };
}

async function getBalance(fs, studentId) {
  const snap = await fs.doc(`tokenBalances/${studentId}`).get();
  return snap.exists ? Math.floor(num(snap.data().balance)) : 0;
}

/**
 * 신규 학생 기본 지급. 잔액 문서가 이미 있으면 아무것도 하지 않는다 —
 * students onCreate 트리거는 재시도될 수 있어서 멱등해야 한다.
 */
async function grantSignupTokens(fs, studentId, opts = {}) {
  const policy = opts.policy || (await getPolicy(fs));
  const amount = Math.max(0, Math.floor(num(opts.amount, policy.signupGrant)));
  const now = Date.now();
  return fs.runTransaction(async (tx) => {
    const { ref, balance, exists } = await readBalance(tx, fs, studentId);
    if (exists) return { granted: false, balance };
    tx.set(ref, { balance: amount, updatedAt: now });
    if (amount !== 0) {
      ledgerEntry(tx, fs, {
        studentId, delta: amount, reason: "signup", refId: "",
        balanceAfter: amount, note: "신규 학생 기본 지급", by: opts.by, now,
      });
    }
    return { granted: true, balance: amount };
  });
}

/** 관리자 수동 증감. 잔액이 음수로 내려가는 조정은 거부한다. */
async function adjustTokens(fs, { studentId, delta, note, by }) {
  const d = Math.floor(num(delta));
  if (!studentId) throw new ApiError(400, "학생을 선택해 주세요.");
  if (!d) throw new ApiError(400, "증감량을 입력해 주세요.");
  const now = Date.now();
  return fs.runTransaction(async (tx) => {
    const { ref, balance } = await readBalance(tx, fs, studentId);
    const next = balance + d;
    if (next < 0) throw new ApiError(400, `잔액(${balance}개)보다 많이 차감할 수 없습니다.`);
    tx.set(ref, { balance: next, updatedAt: now }, { merge: true });
    ledgerEntry(tx, fs, {
      studentId, delta: d, reason: "manual", refId: "",
      balanceAfter: next, note: note || "", by, now,
    });
    return { balance: next };
  });
}

/* ── 질문게시판 ── */

function normPhotos(a) {
  return (Array.isArray(a) ? a : []).slice(0, 8).map((x) => ({
    url: String(x.url || ""),
    path: String(x.path || ""),
    name: String(x.name || ""),
  }));
}

/* 한 스레드에 담을 수 있는 문제 수의 상한. 토큰은 문제 수만큼 곱해서 받는다 —
   답변하는 품이 문제 수에 비례하기 때문이다. 화면 쪽 상한(QA_MAX_PROBLEMS)과 같은 값이어야 한다. */
const MAX_PROBLEMS = 2;

function normProblems(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_PROBLEMS);
}

/**
 * 질문 작성 + 토큰 차감을 한 트랜잭션으로.
 * 잔액 확인과 차감이 같은 트랜잭션 안에 있어야 동시 작성으로 음수가 되지 않는다.
 */
async function createQuestion(fs, { student, title, body, photos, problems, subject }) {
  const t = String(title || "").trim();
  const b = String(body || "").trim();
  /* 과목 목록을 서버에 다시 두지 않는다 — 과목이 늘 때마다 두 군데가 어긋나고,
     학생 자기 질문에 붙는 표시 라벨일 뿐이라 막아서 지킬 게 없다. 고르게 하는 건 화면 몫이고,
     여기서는 길이만 자른다. 빈 값도 받는다: 스토어 배포 전의 앱은 이 칸 없이 보낸다. */
  const subj = String(subject || "").trim().slice(0, 30);
  if (!t) throw new ApiError(400, "제목을 입력해 주세요.");
  if (!b) throw new ApiError(400, "내용을 입력해 주세요.");

  const policy = await getPolicy(fs);
  const count = normProblems(problems);
  const cost = policy.questionCost * count;
  const now = Date.now();

  return fs.runTransaction(async (tx) => {
    const { ref: balRef, balance } = await readBalance(tx, fs, student.id);
    if (balance < cost) {
      throw new ApiError(402, `토큰이 부족합니다. (보유 ${balance}개 / 필요 ${cost}개)`);
    }
    const next = balance - cost;
    const qRef = fs.collection("questions").doc();
    tx.set(qRef, {
      title: t.slice(0, 120),
      body: b,
      photos: normPhotos(photos),
      authorId: student.id,
      authorName: student.name || "",
      authorGrade: student.grade || "",
      status: "pending",
      subject: subj,
      problems: count,
      tokenCost: cost,
      comments: [],
      createdAt: now,
      updatedAt: now,
      answeredAt: null,
    });
    tx.set(balRef, { balance: next, updatedAt: now }, { merge: true });
    ledgerEntry(tx, fs, {
      studentId: student.id, delta: -cost, reason: "question", refId: qRef.id,
      balanceAfter: next, note: t.slice(0, 40) + (count > 1 ? ` (문제 ${count}개)` : ""),
      by: { id: student.id, name: student.name }, now,
    });
    return { id: qRef.id, balance: next };
  });
}

/**
 * 토큰은 질문 스레드를 열 때 한 번만 부과되므로 댓글은 무료다. 학생은 자기 질문에만 달 수 있고, 그 판정은 여기(서버)서 한다.
 * 관리자가 댓글을 달면 질문이 답변완료로 넘어간다.
 */
async function addQuestionComment(fs, { questionId, actor, body, photos }) {
  const b = String(body || "").trim();
  const ph = normPhotos(photos);
  if (!b && !ph.length) throw new ApiError(400, "내용 또는 사진을 입력해 주세요.");
  const now = Date.now();
  const { questionIdleHours: idleHours } = await getPolicy(fs);

  const r = await fs.runTransaction(async (tx) => {
    const qRef = fs.doc(`questions/${questionId}`);
    const snap = await tx.get(qRef);
    if (!snap.exists) throw new ApiError(404, "질문을 찾을 수 없습니다.");
    const q = snap.data();
    if (q.status === "closed") {
      throw new ApiError(409, "종료된 스레드에는 댓글을 달 수 없습니다.");
    }
    /* 스케줄러가 아직 안 돌았어도 시간이 지났으면 여기서 닫는다. 던지면 트랜잭션이
       통째로 되돌아가 종료 표시가 남지 않으므로, 닫고 커밋한 뒤 바깥에서 던진다. */
    if (isIdle(q, idleHours, now)) {
      tx.update(qRef, idleCloseUpdate(now));
      return { idleClosed: true };
    }
    if (actor.role !== "admin" && q.authorId !== actor.id) {
      throw new ApiError(403, "본인 질문에만 댓글을 달 수 있습니다.");
    }
    const comment = {
      _id: `c_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      role: actor.role === "admin" ? "admin" : "student",
      name: actor.name || "",
      authorId: actor.id,
      body: b,
      photos: ph,
      ts: now,
    };
    const upd = {
      comments: [...(Array.isArray(q.comments) ? q.comments : []), comment],
      updatedAt: now,
    };
    if (actor.role === "admin" && q.status !== "answered") {
      upd.status = "answered";
      upd.answeredAt = now;
    }
    tx.update(qRef, upd);
    return {
      comment,
      status: upd.status || q.status,
      authorId: q.authorId || "",
      title: q.title || "",
      authorName: q.authorName || "",
      firstAnswer: upd.status === "answered",
      /* 답변완료 스레드에 학생이 다시 물은 경우. 상태는 답변완료 그대로라
         관리자가 목록만 봐서는 새 글이 달린 걸 알 수 없다. */
      followUp: actor.role !== "admin" && q.status === "answered",
    };
  });
  if (r.idleClosed) throw new ApiError(409, idleClosedMessage(idleHours));
  return r;
}

function idleClosedMessage(hours) {
  return `마지막 활동 후 ${hours}시간이 지나 자동으로 종료된 스레드입니다. 이어서 물어볼 내용은 새 질문으로 남겨 주세요.`;
}

/**
 * 댓글 수정. 사진까지 통째로 갈아 끼우므로 클라이언트가 남길 사진 + 새로 올린 사진을 합쳐 보낸다.
 * 삭제와 달리 관리자에게도 남의 댓글 수정 권한을 주지 않는다 — 지우는 건 조치지만
 * 고치는 건 남의 이름 아래 다른 말을 남기는 것이라 성격이 다르다.
 * 상태는 건드리지 않는다. 관리자가 자기 답변을 고쳤다고 답변대기로 돌아가면 안 된다.
 */
async function editQuestionComment(fs, { questionId, commentId, actor, body, photos }) {
  const b = String(body || "").trim();
  const ph = normPhotos(photos);
  if (!b && !ph.length) throw new ApiError(400, "내용 또는 사진을 입력해 주세요.");
  const now = Date.now();
  const { questionIdleHours: idleHours } = await getPolicy(fs);

  const r = await fs.runTransaction(async (tx) => {
    const qRef = fs.doc(`questions/${questionId}`);
    const snap = await tx.get(qRef);
    if (!snap.exists) throw new ApiError(404, "질문을 찾을 수 없습니다.");
    const q = snap.data();
    if (q.status === "closed") {
      throw new ApiError(409, "종료된 스레드의 댓글은 수정할 수 없습니다.");
    }
    if (isIdle(q, idleHours, now)) {
      tx.update(qRef, idleCloseUpdate(now));
      return { idleClosed: true };
    }
    const list = Array.isArray(q.comments) ? q.comments : [];
    const i = list.findIndex((c) => c._id === commentId);
    if (i < 0) throw new ApiError(404, "댓글을 찾을 수 없습니다.");
    if (list[i].authorId !== actor.id) {
      throw new ApiError(403, "본인 댓글만 수정할 수 있습니다.");
    }
    const next = list.slice();
    next[i] = { ...list[i], body: b, photos: ph, editedAt: now };
    tx.update(qRef, { comments: next, updatedAt: now });
    return { comment: next[i] };
  });
  if (r.idleClosed) throw new ApiError(409, idleClosedMessage(idleHours));
  return r;
}

/** 댓글 삭제. 학생은 자기 댓글만, 관리자는 전부. 토큰은 돌려주지 않는다(애초에 댓글은 무료다). */
async function deleteQuestionComment(fs, { questionId, commentId, actor }) {
  const now = Date.now();
  return fs.runTransaction(async (tx) => {
    const qRef = fs.doc(`questions/${questionId}`);
    const snap = await tx.get(qRef);
    if (!snap.exists) throw new ApiError(404, "질문을 찾을 수 없습니다.");
    const q = snap.data();
    const list = Array.isArray(q.comments) ? q.comments : [];
    const target = list.find((c) => c._id === commentId);
    if (!target) throw new ApiError(404, "댓글을 찾을 수 없습니다.");
    if (actor.role !== "admin" && target.authorId !== actor.id) {
      throw new ApiError(403, "본인 댓글만 삭제할 수 있습니다.");
    }
    const next = list.filter((c) => c._id !== commentId);
    const upd = { comments: next, updatedAt: now };
    // 관리자 댓글이 다 지워지면 다시 답변대기로 돌린다 — 아니면 답변 없는 글이 답변완료로 남는다.
    // 단 종료된 스레드는 건드리지 않는다. 닫아 둔 걸 댓글 삭제로 다시 열면 안 된다.
    if (q.status !== "closed" && !next.some((c) => c.role === "admin")) {
      upd.status = "pending";
      upd.answeredAt = null;
    }
    tx.update(qRef, upd);
    return { ok: true, status: upd.status || q.status };
  });
}

/**
 * 스레드 닫기 / 다시 열기. 관리자만.
 * 닫으면 더 이상 댓글을 달 수 없다. 다시 열 때는 관리자 답변이 있었는지 보고
 * 답변완료 / 답변대기 중 맞는 쪽으로 되돌린다 — 무조건 답변대기로 두면 이미 답한 글이 다시 밀려 올라온다.
 */
async function setQuestionClosed(fs, { questionId, closed, by }) {
  const now = Date.now();
  return fs.runTransaction(async (tx) => {
    const qRef = fs.doc(`questions/${questionId}`);
    const snap = await tx.get(qRef);
    if (!snap.exists) throw new ApiError(404, "질문을 찾을 수 없습니다.");
    const q = snap.data();
    const isClosed = q.status === "closed";
    if (closed && isClosed) throw new ApiError(409, "이미 종료된 스레드입니다.");
    if (!closed && !isClosed) throw new ApiError(409, "종료된 스레드가 아닙니다.");

    if (closed) {
      tx.update(qRef, {
        status: "closed", updatedAt: now, closedReason: "admin",
        closedAt: now, closedById: (by && by.id) || "", closedByName: (by && by.name) || "",
      });
      return { status: "closed" };
    }
    const hasAdmin = (Array.isArray(q.comments) ? q.comments : []).some((c) => c.role === "admin");
    const status = hasAdmin ? "answered" : "pending";
    /* 다시 열면 updatedAt 이 지금으로 올라가 자동 종료 시계도 처음부터 다시 돈다.
       바로 다시 닫히면 열어 준 의미가 없다. */
    tx.update(qRef, { status, updatedAt: now, closedAt: null, closedReason: "", closedById: "", closedByName: "" });
    return { status };
  });
}

/**
 * 자동 종료 일괄 처리 — 스케줄러가 부른다.
 *
 * 화면은 `updatedAt` 으로 종료 여부를 즉시 계산하지만, 저장된 `status` 도 따라가야 한다.
 * 관리자 목록의 답변대기 필터와 새 질문 알림톡의 미답변 건수가 이 필드를 세기 때문이다.
 * 한 번에 다 못 지우면 다음 회차가 이어서 처리하므로 배치 크기만 지킨다.
 */
async function closeIdleQuestions(fs, { now = Date.now(), limit = 400 } = {}) {
  const { questionIdleHours: hours } = await getPolicy(fs);
  if (!hours) return { closed: 0, skipped: "disabled" };
  const cutoff = now - hours * 3600000;
  const snap = await fs.collection("questions")
    .where("status", "==", "answered")
    .where("updatedAt", "<=", cutoff)
    .limit(limit)
    .get();
  if (snap.empty) return { closed: 0 };
  const batch = fs.batch();
  snap.docs.forEach((d) => batch.update(d.ref, idleCloseUpdate(now)));
  await batch.commit();
  return { closed: snap.size };
}

async function deleteQuestion(fs, { questionId, actor }) {
  const qRef = fs.doc(`questions/${questionId}`);
  const snap = await qRef.get();
  if (!snap.exists) throw new ApiError(404, "질문을 찾을 수 없습니다.");
  if (actor.role !== "admin" && snap.data().authorId !== actor.id) {
    throw new ApiError(403, "본인 질문만 삭제할 수 있습니다.");
  }
  // 이미 쓴 토큰은 돌려주지 않는다 — 삭제로 무료 질문이 되면 안 된다.
  await qRef.delete();
  return { ok: true };
}

/* ── 결제 요청 ──
   요청됨 → 발송완료 → 결제완료. 요청됨/발송완료에서만 취소할 수 있다. */

async function createPaymentRequest(fs, { student, packageId, method, depositorName }) {
  const policy = await getPolicy(fs);
  const m = PAY_METHODS.includes(method) ? method : "ppurio";
  if (m === "ppurio" && !policy.ppurioEnabled) throw new ApiError(400, "지금은 결제선생으로 요청할 수 없습니다.");
  if (m === "bank" && !bankReady(policy)) throw new ApiError(400, "지금은 계좌이체로 요청할 수 없습니다.");
  const pkgs = normalizePackages(policy.packages, policy.unitPrice);
  const pkg = pkgs.find((p) => p.id === packageId);
  if (!pkg) throw new ApiError(404, "판매 상품을 찾을 수 없습니다.");
  if (!pkg.active) throw new ApiError(400, "지금은 구매할 수 없는 상품입니다.");
  if (pkg.tokens <= 0) throw new ApiError(400, "토큰 수가 잘못된 상품입니다.");

  const now = Date.now();
  const ref = fs.collection("paymentRequests").doc();
  // 이후 단가·할인이 바뀌어도 이 요청의 금액은 그대로여야 하므로 전부 스냅샷으로 박아 둔다.
  await ref.set({
    studentId: student.id,
    studentName: student.name || "",
    studentPhone: student.phone || "",
    packageId: pkg.id,
    method: m,
    // 나중에 계좌가 바뀌어도 이 요청에 안내한 계좌는 그대로여야 한다.
    bankName: m === "bank" ? policy.bankName : "",
    bankAccount: m === "bank" ? policy.bankAccount : "",
    bankHolder: m === "bank" ? policy.bankHolder : "",
    depositorName: m === "bank" ? String(depositorName || student.name || "").trim().slice(0, 20) : "",
    tokens: pkg.tokens,
    bonus: pkg.bonus,
    totalTokens: pkg.totalTokens,
    unitPrice: policy.unitPrice,
    discountType: pkg.discountType,
    discountValue: pkg.discountValue,
    listPrice: pkg.listPrice,
    discount: pkg.discount,
    amount: pkg.amount,
    status: "requested",
    createdAt: now,
    sentAt: null, sentById: "", sentByName: "",
    paidAt: null, paidById: "", paidByName: "",
    canceledAt: null, canceledById: "", canceledByName: "",
    ledgerId: "",
  });
  return { id: ref.id, method: m, amount: pkg.amount, tokens: pkg.tokens, bonus: pkg.bonus, totalTokens: pkg.totalTokens };
}

async function markPaymentSent(fs, { requestId, by }) {
  const now = Date.now();
  return fs.runTransaction(async (tx) => {
    const ref = fs.doc(`paymentRequests/${requestId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ApiError(404, "결제 요청을 찾을 수 없습니다.");
    const pr = snap.data();
    if (pr.method === "bank") {
      throw new ApiError(409, "계좌이체 요청에는 발송 단계가 없습니다. 입금이 확인되면 바로 결제 완료로 바꾸세요.");
    }
    if (pr.status !== "requested") {
      throw new ApiError(409, `'요청됨' 상태에서만 발송 완료로 바꿀 수 있습니다. (현재: ${pr.status})`);
    }
    tx.update(ref, { status: "sent", sentAt: now, sentById: by.id || "", sentByName: by.name || "" });
    return { status: "sent" };
  });
}

/**
 * 결제 완료 + 토큰 지급. 상태 전이와 지급이 한 트랜잭션 안에 있고,
 * 진입 조건이 status==='sent' 라서 두 번 눌러도 두 번째는 409 로 튕긴다.
 */
async function markPaymentPaid(fs, { requestId, by }) {
  const now = Date.now();
  return fs.runTransaction(async (tx) => {
    const ref = fs.doc(`paymentRequests/${requestId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ApiError(404, "결제 요청을 찾을 수 없습니다.");
    const pr = snap.data();
    if (pr.status === "paid") throw new ApiError(409, "이미 결제 완료 처리된 요청입니다.");
    // 계좌이체는 관리자가 보낼 링크가 없어 '발송완료' 단계를 거치지 않는다.
    const okFrom = pr.method === "bank" ? ["requested", "sent"] : ["sent"];
    if (!okFrom.includes(pr.status)) {
      throw new ApiError(409, `'${okFrom.join("' 또는 '")}' 상태에서만 결제 완료로 바꿀 수 있습니다. (현재: ${pr.status})`);
    }
    // 보너스 필드가 없던 예전 요청은 tokens 로 떨어진다.
    const tokens = Math.max(0, Math.floor(num(pr.totalTokens, num(pr.tokens))));
    const { ref: balRef, balance } = await readBalance(tx, fs, pr.studentId);
    const next = balance + tokens;
    const ledRef = ledgerEntry(tx, fs, {
      studentId: pr.studentId, delta: tokens, reason: "purchase", refId: requestId,
      balanceAfter: next,
      note: num(pr.bonus) > 0 ? `${num(pr.tokens)}토큰 구매 + 보너스 ${num(pr.bonus)}토큰` : `${tokens}토큰 구매`,
      by, now,
    });
    tx.set(balRef, { balance: next, updatedAt: now }, { merge: true });
    tx.update(ref, {
      status: "paid", paidAt: now, paidById: by.id || "", paidByName: by.name || "",
      ledgerId: ledRef.id,
    });
    return { status: "paid", balance: next };
  });
}

async function cancelPaymentRequest(fs, { requestId, by, actor }) {
  const now = Date.now();
  return fs.runTransaction(async (tx) => {
    const ref = fs.doc(`paymentRequests/${requestId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ApiError(404, "결제 요청을 찾을 수 없습니다.");
    const pr = snap.data();
    if (actor && actor.role !== "admin" && pr.studentId !== actor.id) {
      throw new ApiError(403, "본인 결제 요청만 취소할 수 있습니다.");
    }
    if (pr.status !== "requested" && pr.status !== "sent") {
      throw new ApiError(409, `'요청됨'/'발송완료' 상태에서만 취소할 수 있습니다. (현재: ${pr.status})`);
    }
    tx.update(ref, {
      status: "canceled", canceledAt: now,
      canceledById: by.id || "", canceledByName: by.name || "",
    });
    return { status: "canceled" };
  });
}

/** 잔액 문서가 없는 기존 학생에게 기본 지급분을 한 번에 채워 준다. */
async function backfillSignupGrants(fs, { by } = {}) {
  const policy = await getPolicy(fs);
  const students = await fs.collection("students").get();
  let granted = 0;
  for (const doc of students.docs) {
    if (doc.data().withdrawn === true) continue;
    const r = await grantSignupTokens(fs, doc.id, { policy, by });
    if (r.granted) granted++;
  }
  return { granted, total: students.size };
}

async function savePolicy(fs, patch) {
  const cur = await getPolicy(fs);
  const next = {
    signupGrant: Math.max(0, Math.floor(num(patch.signupGrant, cur.signupGrant))),
    questionCost: Math.max(0, Math.floor(num(patch.questionCost, cur.questionCost))),
    unitPrice: Math.max(0, Math.floor(num(patch.unitPrice, cur.unitPrice))),
    packages: normalizePackages(
      patch.packages === undefined ? cur.packages : patch.packages,
      Math.max(0, Math.floor(num(patch.unitPrice, cur.unitPrice)))
    ).map((p) => ({
      id: p.id, tokens: p.tokens, bonus: p.bonus, active: p.active, order: p.order,
      discountType: p.discountType, discountValue: p.discountValue,
    })),
    ppurioEnabled: patch.ppurioEnabled === undefined ? cur.ppurioEnabled : patch.ppurioEnabled !== false,
    bankEnabled: patch.bankEnabled === undefined ? cur.bankEnabled : patch.bankEnabled === true,
    bankName: String(patch.bankName === undefined ? cur.bankName : patch.bankName || "").trim().slice(0, 30),
    bankAccount: String(patch.bankAccount === undefined ? cur.bankAccount : patch.bankAccount || "").trim().slice(0, 40),
    bankHolder: String(patch.bankHolder === undefined ? cur.bankHolder : patch.bankHolder || "").trim().slice(0, 20),
    questionIdleHours: clampIdleHours(
      patch.questionIdleHours === undefined ? cur.questionIdleHours : patch.questionIdleHours,
      cur.questionIdleHours
    ),
    updatedAt: Date.now(),
  };
  await fs.doc(POLICY_DOC).set(next, { merge: true });
  return next;
}

module.exports = {
  ApiError,
  POLICY_DOC,
  DEFAULT_POLICY,
  PR_STATUS,
  Q_STATUS,
  PAY_METHODS,
  bankReady,
  LEDGER_REASONS,
  getPolicy,
  savePolicy,
  packagePrice,
  normalizePackages,
  getBalance,
  grantSignupTokens,
  adjustTokens,
  createQuestion,
  MAX_PROBLEMS,
  addQuestionComment,
  editQuestionComment,
  deleteQuestionComment,
  setQuestionClosed,
  closeIdleQuestions,
  idleDeadline,
  isIdle,
  deleteQuestion,
  createPaymentRequest,
  markPaymentSent,
  markPaymentPaid,
  cancelPaymentRequest,
  backfillSignupGrants,
};
