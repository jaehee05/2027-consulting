const admin = require("firebase-admin");
admin.initializeApp();

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const { sendAlimtalk, sendAlimtalkToAdmins } = require("./ppurio");

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
  // admin_change 수락 시에는 request.chosenSlot 에 선택한 슬롯이 들어간다
  const chosen = request?.chosenSlot;
  return {
    phone: student?.studentPhone,
    name: (request?.studentName) || (booking?.studentName) || student?.name || "",
    school: student?.school || "",
    grade: student?.grade || "",
    seat: student?.seat ?? "",
    dateLabel: request?.currentDateLabel || booking?.dateLabel || "",
    slot: request?.currentSlot || booking?.slot || "",
    currentDateLabel: request?.currentDateLabel || booking?.dateLabel || "",
    currentSlot: request?.currentSlot || booking?.slot || "",
    newDateLabel: request?.newDateLabel || chosen?.dateLabel || "",
    newSlot: request?.newSlot || chosen?.slot || "",
    reason: request?.rejectReason || request?.reason || "",
    offeredSlots: fmtOfferedSlots(request?.offeredSlots),
    accountId: student?.accountId || "",
    accountPw: student?.accountPw || "",
  };
}

async function safeSend(key, ctx) {
  try { await sendAlimtalk(key, ctx); }
  catch (err) { console.error(`[${key}] 학생 발송 실패:`, err); }
}
async function safeSendAdmins(key, ctx) {
  try { await sendAlimtalkToAdmins(key, ctx); }
  catch (err) { console.error(`[${key}] 관리자 발송 실패:`, err); }
}

exports.onBookingCreate = onDocumentCreated("bookings/{id}", async (e) => {
  try {
    const b = e.data.data();
    const s = await loadStudent(b.studentId);
    if (s?.isTest) return;
    const ctx = baseCtx(s, b, null);
    await safeSend("bookingComplete", ctx);
    await safeSendAdmins("adminNotifyBooking", ctx);
  } catch (err) {
    console.error("onBookingCreate 실패:", err);
  }
});

exports.onRequestCreate = onDocumentCreated("requests/{id}", async (e) => {
  try {
    const r = e.data.data();
    const s = await loadStudent(r.studentId);
    if (s?.isTest) return;
    const ctx = baseCtx(s, null, r);
    if (r.type === "change") {
      await safeSend("changeRequest", ctx);
      await safeSendAdmins("adminNotifyChangeRequest", ctx);
    } else if (r.type === "cancel") {
      await safeSend("cancelRequest", ctx);
      await safeSendAdmins("adminNotifyCancelRequest", ctx);
    } else if (r.type === "admin_change") {
      await safeSend("adminChangeRequest", ctx);
    }
  } catch (err) {
    console.error("onRequestCreate 실패:", err);
  }
});

exports.onRequestUpdate = onDocumentUpdated("requests/{id}", async (e) => {
  try {
    const before = e.data.before.data();
    const after = e.data.after.data();
    if (before.status === after.status) return;

    const s = await loadStudent(after.studentId);
    if (s?.isTest) return;
    const ctx = baseCtx(s, null, after);

    if (after.type === "change" && after.status === "approved") {
      await safeSend("changeApproved", ctx);
    } else if (after.type === "change" && after.status === "rejected") {
      await safeSend("changeRejected", ctx);
    } else if (after.type === "cancel" && after.status === "approved") {
      await safeSend("cancelApproved", ctx);
    } else if (after.type === "cancel" && after.status === "rejected") {
      await safeSend("cancelRejected", ctx);
    } else if (after.type === "admin_change" && after.status === "accepted") {
      // 학생이 관리자 변경 요청을 수락 (상태명은 'accepted')
      await safeSend("adminChangeApproved", ctx);
      await safeSendAdmins("adminNotifyAdminChangeApproved", ctx);
    } else if (after.type === "admin_change" && after.status === "rejected") {
      await safeSend("adminChangeRejected", ctx);
      await safeSendAdmins("adminNotifyAdminChangeRejected", ctx);
    }
  } catch (err) {
    console.error("onRequestUpdate 실패:", err);
  }
});

// 신규 학생 계정 안내 (accountCreated) 는 자동 발송하지 않는다.
// 관리자가 학생 관리 탭에서 선택하여 수동으로 발송한다.
// → ppurioAdmin 의 action='sendAccountInfo' 참고.

// 성적 미입력 리마인더: 매일 오전 9시(KST), 활성 시험 중 D-7/3/1/0 에 미입력 학생에게 발송
const REMINDER_DAYS = [7, 3, 1, 0];

function todayStrKST() {
  // 서버 시간대와 무관하게 KST 기준 YYYY-MM-DD
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function daysBetween(fromStr, toStr) {
  const a = new Date(fromStr + "T00:00:00Z").getTime();
  const b = new Date(toStr + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

function hasExamScore(student, examId) {
  const sc = student?.scores?.[examId];
  return !!(sc && Object.values(sc).some((v) => v !== undefined && v !== null && v !== ""));
}

async function runScoreReminderPass() {
  const cfgSnap = await admin.firestore().doc("config/main").get();
  const exams = cfgSnap.exists ? (cfgSnap.data().exams || []) : [];
  const today = todayStrKST();

  const targets = exams.filter((ex) => {
    if (!ex?.scoreStart || !ex?.scoreEnd || !ex?.id) return false;
    if (today < ex.scoreStart || today > ex.scoreEnd) return false;
    const d = daysBetween(today, ex.scoreEnd);
    return REMINDER_DAYS.includes(d);
  });
  if (targets.length === 0) {
    console.log("[scoreInputReminder] 해당 D-day 시험 없음 — 건너뜀");
    return { sent: 0 };
  }

  const studentsSnap = await admin.firestore().collection("students").get();
  let sent = 0;
  for (const ex of targets) {
    const daysLeft = daysBetween(today, ex.scoreEnd);
    for (const d of studentsSnap.docs) {
      const s = d.data();
      if (s.isTest) continue;
      if (!s.studentPhone || !/\d{9,}/.test(String(s.studentPhone))) continue;
      if (hasExamScore(s, ex.id)) continue;
      await safeSend("scoreInputReminder", {
        phone: s.studentPhone,
        name: s.name || "",
        school: s.school || "",
        grade: s.grade || "",
        seat: s.seat ?? "",
        examName: ex.name || "",
        scoreDeadline: ex.scoreEnd,
        daysLeft: String(daysLeft),
      });
      sent += 1;
    }
  }
  console.log(`[scoreInputReminder] 발송 ${sent}건`);
  return { sent };
}

exports.scoreReminderDaily = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Seoul", region: "asia-northeast3" },
  async () => { await runScoreReminderPass(); }
);

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
        adminPhones: Array.isArray(d.adminPhones) ? d.adminPhones : [],
        templates: d.templates || {},
      });
    }

    if (action === "save") {
      const p = payload || {};
      const existingSnap = await admin.firestore().doc("settings/ppurio").get();
      const existing = existingSnap.exists ? existingSnap.data() : {};
      const adminPhones = Array.isArray(p.adminPhones)
        ? p.adminPhones.map((x) => String(x || "").replace(/\D/g, "")).filter((x) => x.length >= 9)
        : [];
      // 중첩 맵(templates/changeWord)의 잔여 키 누적을 막기 위해 merge 없이 통째로 덮어쓴다.
      // apiKey는 새 값이 오지 않으면 기존 값을 유지.
      const update = {
        enabled: p.enabled !== false,
        ppurioAccount: p.ppurioAccount || "",
        senderProfile: p.senderProfile || "",
        templates: p.templates || {},
        adminPhones,
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

    if (action === "runScoreReminder") {
      const r = await runScoreReminderPass();
      return res.json({ ok: true, result: r });
    }

    if (action === "sendAccountInfo") {
      const ids = Array.isArray(payload?.studentIds) ? payload.studentIds.filter(Boolean) : [];
      if (ids.length === 0) return res.status(400).json({ error: "studentIds 가 비어있습니다." });
      const results = [];
      for (const id of ids) {
        const snap = await admin.firestore().doc(`students/${id}`).get();
        if (!snap.exists) { results.push({ id, ok: false, skipped: "not-found" }); continue; }
        const s = snap.data();
        if (s.isTest) { results.push({ id, name: s.name, ok: false, skipped: "test-account" }); continue; }
        const phone = String(s.studentPhone || "").replace(/\D/g, "");
        if (phone.length < 9) { results.push({ id, name: s.name, ok: false, skipped: "no-phone" }); continue; }
        try {
          const r = await sendAlimtalk("accountCreated", {
            phone,
            name: s.name || "",
            school: s.school || "",
            grade: s.grade || "",
            seat: s.seat ?? "",
            accountId: s.accountId || "",
            accountPw: s.accountPw || "",
          });
          results.push({ id, name: s.name, ok: true, result: r });
        } catch (err) {
          console.error(`[accountCreated] ${s.name}(${id}) 발송 실패:`, err);
          results.push({ id, name: s.name, ok: false, error: String(err.message || err) });
        }
      }
      const sent = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).length;
      return res.json({ ok: true, sent, failed, results });
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
