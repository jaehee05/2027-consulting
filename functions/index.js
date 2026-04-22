const admin = require("firebase-admin");
admin.initializeApp();

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { sendAlimtalk } = require("./ppurio");

setGlobalOptions({ region: "asia-northeast3", retry: false, maxInstances: 10 });

async function loadStudent(studentId) {
  if (!studentId) return null;
  const snap = await admin.firestore().doc(`students/${studentId}`).get();
  return snap.exists ? snap.data() : null;
}

function fmtOfferedSlots(offered) {
  if (!Array.isArray(offered)) return "";
  return offered.map((s) => `${s.dateLabel} ${s.slot}`).join(" / ");
}

function baseCtx(student, booking, request) {
  return {
    phone: student?.studentPhone,
    name: (request?.studentName) || (booking?.studentName) || student?.name || "",
    school: student?.school || "",
    grade: student?.grade || "",
    seat: student?.seat ?? "",
    dateLabel: request?.currentDateLabel || booking?.dateLabel || "",
    slot: request?.currentSlot || booking?.slot || "",
    currentDateLabel: request?.currentDateLabel || "",
    currentSlot: request?.currentSlot || "",
    newDateLabel: request?.newDateLabel || "",
    newSlot: request?.newSlot || "",
    reason: request?.rejectReason || request?.reason || "",
    offeredSlots: fmtOfferedSlots(request?.offeredSlots),
  };
}

exports.onBookingCreate = onDocumentCreated("bookings/{id}", async (e) => {
  try {
    const b = e.data.data();
    const s = await loadStudent(b.studentId);
    await sendAlimtalk("bookingComplete", baseCtx(s, b, null));
  } catch (err) {
    console.error("bookingComplete 실패:", err);
  }
});

exports.onRequestCreate = onDocumentCreated("requests/{id}", async (e) => {
  try {
    const r = e.data.data();
    const s = await loadStudent(r.studentId);
    const ctx = baseCtx(s, null, r);
    if (r.type === "change") await sendAlimtalk("changeRequest", ctx);
    else if (r.type === "cancel") await sendAlimtalk("cancelRequest", ctx);
    else if (r.type === "admin_change") await sendAlimtalk("adminChangeRequest", ctx);
  } catch (err) {
    console.error("request onCreate 실패:", err);
  }
});

exports.onRequestUpdate = onDocumentUpdated("requests/{id}", async (e) => {
  try {
    const before = e.data.before.data();
    const after = e.data.after.data();
    if (before.status === after.status) return;
    if (after.type !== "change" && after.type !== "cancel") return;

    const s = await loadStudent(after.studentId);
    const ctx = baseCtx(s, null, after);
    const key =
      after.type === "change" && after.status === "approved" ? "changeApproved" :
      after.type === "change" && after.status === "rejected" ? "changeRejected" :
      after.type === "cancel" && after.status === "approved" ? "cancelApproved" :
      after.type === "cancel" && after.status === "rejected" ? "cancelRejected" : null;
    if (key) await sendAlimtalk(key, ctx);
  } catch (err) {
    console.error("request onUpdate 실패:", err);
  }
});

// ───────────────────────────────────────────────
// 관리자 페이지용 HTTP 엔드포인트 (설정 CRUD + 테스트 발송)
// 클라이언트는 firebase-functions의 callable이 아니라 단순 fetch 사용
// 관리자 인증은 admins/{adminId} 문서의 password 와 대조
// ───────────────────────────────────────────────

async function verifyAdmin(adminId, adminPw) {
  if (!adminId || !adminPw) return false;
  const d = await admin.firestore().doc(`admins/${adminId}`).get();
  if (!d.exists) return false;
  const a = d.data();
  return a.password === adminPw;
}

function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

exports.ppurioAdmin = onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { action, adminId, adminPw, payload } = req.body || {};
    if (!(await verifyAdmin(adminId, adminPw))) {
      return res.status(401).json({ error: "관리자 인증 실패" });
    }

    if (action === "get") {
      const snap = await admin.firestore().doc("settings/ppurio").get();
      const d = snap.exists ? snap.data() : {};
      // API 키는 마스킹해서 반환 (편집 UI에 원키를 다시 내려주지 않음)
      const apiKeyMasked = d.apiKey ? "••••" + String(d.apiKey).slice(-4) : "";
      return res.json({
        enabled: d.enabled !== false,
        ppurioAccount: d.ppurioAccount || "",
        senderProfile: d.senderProfile || "",
        apiKeyMasked,
        hasApiKey: !!d.apiKey,
        templates: d.templates || {},
      });
    }

    if (action === "save") {
      const p = payload || {};
      const existingSnap = await admin.firestore().doc("settings/ppurio").get();
      const existing = existingSnap.exists ? existingSnap.data() : {};
      // 중첩 맵(templates/changeWord)의 잔여 키 누적을 막기 위해 merge 없이 통째로 덮어쓴다.
      // apiKey는 새 값이 오지 않으면 기존 값을 유지.
      const update = {
        enabled: p.enabled !== false,
        ppurioAccount: p.ppurioAccount || "",
        senderProfile: p.senderProfile || "",
        templates: p.templates || {},
        apiKey: p.apiKey || existing.apiKey || "",
        updatedAt: Date.now(),
        updatedBy: adminId,
      };
      await admin.firestore().doc("settings/ppurio").set(update);
      if (p.apiKey || p.ppurioAccount) {
        await admin.firestore().doc("settings/ppurio_token").delete().catch(() => {});
      }
      return res.json({ ok: true });
    }

    if (action === "test") {
      const p = payload || {};
      const result = await sendAlimtalk(p.eventKey, {
        phone: p.phone,
        name: p.name || "테스트",
        school: "테스트고", grade: "고3", seat: 1,
        dateLabel: "6월 5일 (금)", slot: "10:00",
        currentDateLabel: "6월 5일 (금)", currentSlot: "10:00",
        newDateLabel: "6월 6일 (토)", newSlot: "14:00",
        reason: "테스트 사유입니다.",
        offeredSlots: "6월 6일 (토) 14:00 / 6월 7일 (일) 10:00",
        accountId: "test_stu",
        accountPw: "01012345678",
        examName: "6월 모의평가",
        scoreDeadline: "2026-06-20",
        daysLeft: "3",
      });
      return res.json({ ok: true, result });
    }

    return res.status(400).json({ error: "알 수 없는 action" });
  } catch (err) {
    console.error("ppurioAdmin 오류:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});
