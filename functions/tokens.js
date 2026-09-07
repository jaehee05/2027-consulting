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
};

const LEDGER_REASONS = ["signup", "question", "purchase", "manual"];
const PR_STATUS = ["requested", "sent", "paid", "canceled"];

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
  };
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
      return {
        id: String(p.id || `pkg_${i}`),
        tokens: price.tokens,
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

/**
 * 질문 작성 + 토큰 차감을 한 트랜잭션으로.
 * 잔액 확인과 차감이 같은 트랜잭션 안에 있어야 동시 작성으로 음수가 되지 않는다.
 */
async function createQuestion(fs, { student, title, body, photos }) {
  const t = String(title || "").trim();
  const b = String(body || "").trim();
  if (!t) throw new ApiError(400, "제목을 입력해 주세요.");
  if (!b) throw new ApiError(400, "내용을 입력해 주세요.");

  const policy = await getPolicy(fs);
  const cost = policy.questionCost;
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
      tokenCost: cost,
      comments: [],
      createdAt: now,
      updatedAt: now,
      answeredAt: null,
    });
    tx.set(balRef, { balance: next, updatedAt: now }, { merge: true });
    ledgerEntry(tx, fs, {
      studentId: student.id, delta: -cost, reason: "question", refId: qRef.id,
      balanceAfter: next, note: t.slice(0, 40), by: { id: student.id, name: student.name }, now,
    });
    return { id: qRef.id, balance: next };
  });
}

/**
 * 댓글은 토큰을 쓰지 않는다. 학생은 자기 질문에만 달 수 있고, 그 판정은 여기(서버)서 한다.
 * 관리자가 댓글을 달면 질문이 답변완료로 넘어간다.
 */
async function addQuestionComment(fs, { questionId, actor, body, photos }) {
  const b = String(body || "").trim();
  const ph = normPhotos(photos);
  if (!b && !ph.length) throw new ApiError(400, "내용 또는 사진을 입력해 주세요.");
  const now = Date.now();

  return fs.runTransaction(async (tx) => {
    const qRef = fs.doc(`questions/${questionId}`);
    const snap = await tx.get(qRef);
    if (!snap.exists) throw new ApiError(404, "질문을 찾을 수 없습니다.");
    const q = snap.data();
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
    return { comment };
  });
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

async function createPaymentRequest(fs, { student, packageId }) {
  const policy = await getPolicy(fs);
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
    tokens: pkg.tokens,
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
  return { id: ref.id, amount: pkg.amount, tokens: pkg.tokens };
}

async function markPaymentSent(fs, { requestId, by }) {
  const now = Date.now();
  return fs.runTransaction(async (tx) => {
    const ref = fs.doc(`paymentRequests/${requestId}`);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ApiError(404, "결제 요청을 찾을 수 없습니다.");
    const pr = snap.data();
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
    if (pr.status !== "sent") {
      throw new ApiError(409, `'발송완료' 상태에서만 결제 완료로 바꿀 수 있습니다. (현재: ${pr.status})`);
    }
    const tokens = Math.max(0, Math.floor(num(pr.tokens)));
    const { ref: balRef, balance } = await readBalance(tx, fs, pr.studentId);
    const next = balance + tokens;
    const ledRef = ledgerEntry(tx, fs, {
      studentId: pr.studentId, delta: tokens, reason: "purchase", refId: requestId,
      balanceAfter: next, note: `${tokens}토큰 구매`, by, now,
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
      id: p.id, tokens: p.tokens, active: p.active, order: p.order,
      discountType: p.discountType, discountValue: p.discountValue,
    })),
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
  LEDGER_REASONS,
  getPolicy,
  savePolicy,
  packagePrice,
  normalizePackages,
  getBalance,
  grantSignupTokens,
  adjustTokens,
  createQuestion,
  addQuestionComment,
  deleteQuestion,
  createPaymentRequest,
  markPaymentSent,
  markPaymentPaid,
  cancelPaymentRequest,
  backfillSignupGrants,
};
