const admin = require("firebase-admin");
admin.initializeApp();

const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { sendAlimtalk, sendAlimtalkToAdmins } = require("./ppurio");

setGlobalOptions({ region: "asia-northeast3", retry: false, maxInstances: 10 });

async function loadStudent(studentId) {
  if (!studentId) return null;
  const snap = await admin.firestore().doc(`students/${studentId}`).get();
  return snap.exists ? snap.data() : null;
}

// 학생 연락처가 없는 경우(noStudentPhone) 보호자 연락처를 사용한다.
function notifyPhone(student) {
  if (!student) return "";
  if (student.noStudentPhone) return student.guardianPhone || "";
  return student.studentPhone || student.guardianPhone || "";
}

// 계정 안내 / 예약 시작 안내처럼 학생·보호자 양쪽에 모두 보내야 하는 경우 사용.
// 정규화·길이검증·중복제거된 [{ phone, role }] 배열을 반환한다.
function notifyPhonesBoth(student) {
  if (!student) return [];
  const list = [];
  if (!student.noStudentPhone && student.studentPhone) {
    list.push({ phone: student.studentPhone, role: "student" });
  }
  if (student.guardianPhone) {
    list.push({ phone: student.guardianPhone, role: "guardian" });
  }
  const seen = new Set();
  const out = [];
  for (const { phone, role } of list) {
    const p = String(phone).replace(/\D/g, "");
    if (p.length < 9) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ phone: p, role });
  }
  return out;
}

function fmtOfferedSlots(offered) {
  if (!Array.isArray(offered)) return "";
  return offered.map((s) => `${s.dateLabel} ${s.slot}`).join(" / ");
}

function baseCtx(student, booking, request) {
  // admin_change 수락 시에는 request.chosenSlot 에 선택한 슬롯이 들어간다
  const chosen = request?.chosenSlot;
  return {
    phone: notifyPhone(student),
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
    if (!s?.notifyExcluded) await safeSend("bookingComplete", ctx);
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
    const stuOk = !s?.notifyExcluded;
    if (r.type === "change") {
      if (stuOk) await safeSend("changeRequest", ctx);
      await safeSendAdmins("adminNotifyChangeRequest", ctx);
    } else if (r.type === "cancel") {
      if (stuOk) await safeSend("cancelRequest", ctx);
      await safeSendAdmins("adminNotifyCancelRequest", ctx);
    } else if (r.type === "admin_change") {
      if (stuOk) await safeSend("adminChangeRequest", ctx);
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
    const stuOk = !s?.notifyExcluded;

    if (after.type === "change" && after.status === "approved") {
      if (stuOk) await safeSend("changeApproved", ctx);
    } else if (after.type === "change" && after.status === "rejected") {
      if (stuOk) await safeSend("changeRejected", ctx);
    } else if (after.type === "cancel" && after.status === "approved") {
      if (stuOk) await safeSend("cancelApproved", ctx);
    } else if (after.type === "cancel" && after.status === "rejected") {
      if (stuOk) await safeSend("cancelRejected", ctx);
    } else if (after.type === "admin_change" && after.status === "accepted") {
      // 학생이 관리자 변경 요청을 수락 (상태명은 'accepted')
      if (stuOk) await safeSend("adminChangeApproved", ctx);
      await safeSendAdmins("adminNotifyAdminChangeApproved", ctx);
    } else if (after.type === "admin_change" && after.status === "rejected") {
      if (stuOk) await safeSend("adminChangeRejected", ctx);
      await safeSendAdmins("adminNotifyAdminChangeRejected", ctx);
    }
  } catch (err) {
    console.error("onRequestUpdate 실패:", err);
  }
});

// 신규 학생 계정 안내(accountCreated) 와 성적 미입력 안내(scoreInputReminder) 는 자동 발송하지 않고,
// 관리자가 학생 관리 탭에서 수동으로 발송한다.
// → ppurioAdmin 의 action='sendAccountInfo' / 'sendScoreReminder' 참고.

function todayStrKST() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function daysBetween(fromStr, toStr) {
  const a = new Date(fromStr + "T00:00:00Z").getTime();
  const b = new Date(toStr + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

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

// Firebase Auth ID token (Bearer) 검증. admin/viewer 클레임만 통과시킨다.
// 반환값: 디코딩된 토큰 (role/loginId/name 포함) 또는 null.
async function verifyAdminAuth(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const idToken = auth.slice(7).trim();
  if (!idToken) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (decoded.role !== "admin" && decoded.role !== "viewer") return null;
    return decoded;
  } catch (e) {
    return null;
  }
}

// ppurioAdmin 등 기존 엔드포인트와의 호환을 위해 헤더 우선 / body fallback.
async function verifyAdminAuthOrBody(req) {
  const fromHeader = await verifyAdminAuth(req);
  if (fromHeader) return { loginId: fromHeader.loginId, role: fromHeader.role };
  const { adminId, adminPw } = req.body || {};
  if (await verifyAdmin(adminId, adminPw)) return { loginId: adminId, role: "admin" };
  return null;
}

// 클라이언트로 내려도 되는 admin 문서 필드(평문 password/pinCode 제외).
function publicAdminFields(id, d) {
  return {
    _docId: id,
    id,
    name: d.name || "",
    role: d.role || "",
    phone: d.phone || "",
    linkedStudentId: d.linkedStudentId || null,
    pinSet: !!d.pinCode,
    pinSetAt: d.pinSetAt || null,
    createdAt: d.createdAt || null,
  };
}

function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// 로그인 ID/PW 검증 후 Firebase Custom Token 발급.
// 클라이언트는 이 토큰으로 signInWithCustomToken 하여 Firestore 에 접근한다.
exports.loginToken = onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { id, password, pin } = req.body || {};
    if (!id || !password) return res.status(400).json({ error: "id/password required" });
    const fs = admin.firestore();

    const adminDoc = await fs.doc(`admins/${id}`).get();
    if (adminDoc.exists) {
      const a = adminDoc.data();
      if (a.password === password) {
        // 2차 비밀번호 검사 (admin 역할 + pinCode 설정된 경우)
        if (a.role === "admin" && a.pinCode) {
          if (!pin) return res.json({ needsPin: true });
          if (String(pin) !== String(a.pinCode)) {
            return res.status(401).json({ error: "2차 비밀번호가 올바르지 않습니다.", pinError: true });
          }
        }
        if (a.role === "test") {
          const uid = `test_${id}`;
          const claims = { role: "student", isTest: true, name: a.name || "", loginId: id, studentId: a.linkedStudentId || "" };
          const token = await admin.auth().createCustomToken(uid, claims);
          return res.json({ token, type: "student", isTest: true, id, name: a.name || "", studentDocId: a.linkedStudentId || null });
        }
        const uid = `admin_${id}`;
        const claims = { role: a.role, name: a.name || "", loginId: id };
        const token = await admin.auth().createCustomToken(uid, claims);
        return res.json({ token, type: a.role, id, name: a.name || "" });
      }
    }

    const stuQ = await fs.collection("students").where("accountId", "==", id).get();
    if (!stuQ.empty) {
      const stuDoc = stuQ.docs[0];
      const stu = stuDoc.data();
      if (stu.accountPw === password) {
        if (stu.withdrawn === true) return res.status(403).json({ error: "withdrawn", withdrawn: true });
        const uid = `stu_${stuDoc.id}`;
        const claims = { role: "student", name: stu.name || "", loginId: id, studentId: stuDoc.id };
        const token = await admin.auth().createCustomToken(uid, claims);
        return res.json({ token, type: "student", id, name: stu.name || "", studentDocId: stuDoc.id, isFirstLogin: !!stu.isFirstLogin });
      }
    }

    return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
  } catch (err) {
    console.error("loginToken 오류:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

// 관리자 계정 CRUD 엔드포인트. admins 컬렉션 클라이언트 read/write 차단 후 모든 접근은 이 함수 경유.
// 인증: Authorization: Bearer <Firebase ID Token>. role=admin/viewer 만 통과.
// 일부 액션(hasAny, initial)은 부트스트랩 용도로 무인증 허용.
exports.adminApi = onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { action, payload } = req.body || {};
    const fs = admin.firestore();

    if (action === "hasAny") {
      const snap = await fs.collection("admins").limit(1).get();
      return res.json({ any: !snap.empty });
    }

    if (action === "initial") {
      const snap = await fs.collection("admins").limit(1).get();
      if (!snap.empty) return res.status(403).json({ error: "이미 관리자 계정이 존재합니다." });
      const p = payload || {};
      if (!p.id || !p.name || !p.password) return res.status(400).json({ error: "필수 필드 누락" });
      if (String(p.password).length < 6) return res.status(400).json({ error: "비밀번호는 6자 이상" });
      await fs.doc(`admins/${p.id}`).set({
        id: p.id,
        name: p.name,
        password: p.password,
        role: "admin",
        createdAt: Date.now(),
      });
      return res.json({ ok: true });
    }

    // 이하 액션은 관리자 인증 필요
    const me = await verifyAdminAuth(req);
    if (!me) return res.status(401).json({ error: "관리자 인증 실패" });
    const myId = me.loginId;
    const isAdmin = me.role === "admin";

    if (action === "list") {
      const snap = await fs.collection("admins").get();
      const list = snap.docs.map((d) => publicAdminFields(d.id, d.data()));
      return res.json({ admins: list });
    }

    if (action === "checkExists") {
      const id = payload?.id;
      if (!id) return res.status(400).json({ error: "id required" });
      const d = await fs.doc(`admins/${id}`).get();
      return res.json({ exists: d.exists });
    }

    if (action === "create") {
      if (!isAdmin) return res.status(403).json({ error: "ADMIN 권한 필요" });
      const p = payload || {};
      if (!p.id || !p.name || !p.password) return res.status(400).json({ error: "필수 필드 누락" });
      if (String(p.password).length < 6) return res.status(400).json({ error: "비밀번호는 6자 이상" });
      const existing = await fs.doc(`admins/${p.id}`).get();
      if (existing.exists) return res.status(409).json({ error: `ID '${p.id}'가 이미 존재합니다.` });
      const data = {
        id: p.id,
        name: p.name,
        role: p.role || "viewer",
        password: p.password,
        phone: p.phone || "",
        createdAt: Date.now(),
      };
      if (p.linkedStudentId) data.linkedStudentId = p.linkedStudentId;
      await fs.doc(`admins/${p.id}`).set(data);
      return res.json({ ok: true, admin: publicAdminFields(p.id, data) });
    }

    if (action === "update") {
      const p = payload || {};
      if (!p.id || !p.fields) return res.status(400).json({ error: "id/fields required" });
      if (!isAdmin && p.id !== myId) return res.status(403).json({ error: "권한 없음" });
      const allowed = {};
      if ("name" in p.fields) allowed.name = String(p.fields.name || "");
      if ("role" in p.fields && isAdmin) allowed.role = String(p.fields.role || "");
      if ("phone" in p.fields) allowed.phone = String(p.fields.phone || "");
      if ("password" in p.fields && p.fields.password) {
        if (String(p.fields.password).length < 6) return res.status(400).json({ error: "비밀번호는 6자 이상" });
        allowed.password = p.fields.password;
      }
      if (Object.keys(allowed).length === 0) return res.status(400).json({ error: "변경할 필드가 없습니다." });
      await fs.doc(`admins/${p.id}`).update(allowed);
      return res.json({ ok: true });
    }

    if (action === "delete") {
      if (!isAdmin) return res.status(403).json({ error: "ADMIN 권한 필요" });
      const p = payload || {};
      if (!p.id) return res.status(400).json({ error: "id required" });
      if (p.id === myId) return res.status(403).json({ error: "본인 계정은 삭제할 수 없습니다." });
      await fs.doc(`admins/${p.id}`).delete();
      return res.json({ ok: true });
    }

    if (action === "setPin") {
      const p = payload || {};
      if (!/^\d{6}$/.test(String(p.newPin || ""))) return res.status(400).json({ error: "새 PIN은 6자리 숫자여야 합니다." });
      const myDoc = await fs.doc(`admins/${myId}`).get();
      if (!myDoc.exists) return res.status(404).json({ error: "계정을 찾을 수 없습니다." });
      const cur = myDoc.data();
      if (cur.pinCode && String(cur.pinCode) !== String(p.currentPin || "")) {
        return res.status(401).json({ error: "현재 PIN이 올바르지 않습니다." });
      }
      await fs.doc(`admins/${myId}`).update({ pinCode: String(p.newPin), pinSetAt: Date.now() });
      return res.json({ ok: true });
    }

    if (action === "removePin") {
      const p = payload || {};
      const myDoc = await fs.doc(`admins/${myId}`).get();
      if (!myDoc.exists) return res.status(404).json({ error: "계정을 찾을 수 없습니다." });
      const cur = myDoc.data();
      if (!cur.pinCode) return res.json({ ok: true });
      if (String(cur.pinCode) !== String(p.currentPin || "")) {
        return res.status(401).json({ error: "현재 PIN이 올바르지 않습니다." });
      }
      await fs.doc(`admins/${myId}`).update({
        pinCode: admin.firestore.FieldValue.delete(),
        pinSetAt: admin.firestore.FieldValue.delete(),
      });
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action: " + action });
  } catch (err) {
    console.error("adminApi 오류:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

exports.ppurioAdmin = onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { action, adminId, payload } = req.body || {};
    const authedAdmin = await verifyAdminAuthOrBody(req);
    if (!authedAdmin) {
      return res.status(401).json({ error: "관리자 인증 실패" });
    }
    const actingAdminId = authedAdmin.loginId || adminId;

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
        footer: d.footer || "",
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
        footer: String(p.footer || ""),
        apiKey: p.apiKey || existing.apiKey || "",
        updatedAt: Date.now(),
        updatedBy: actingAdminId,
      };
      await admin.firestore().doc("settings/ppurio").set(update);
      if (p.apiKey || p.ppurioAccount) {
        await admin.firestore().doc("settings/ppurio_token").delete().catch(() => {});
      }
      return res.json({ ok: true });
    }

    if (action === "sendScoreReminder") {
      const p = payload || {};
      const ids = Array.isArray(p.studentIds) ? p.studentIds.filter(Boolean) : [];
      const examName = String(p.examName || "").trim();
      const scoreDeadline = String(p.scoreDeadline || "").trim();
      if (ids.length === 0) return res.status(400).json({ error: "studentIds 가 비어있습니다." });
      if (!examName) return res.status(400).json({ error: "examName 이 필요합니다." });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(scoreDeadline)) return res.status(400).json({ error: "scoreDeadline 은 YYYY-MM-DD 형식이어야 합니다." });
      const today = todayStrKST();
      const daysLeft = Math.max(0, daysBetween(today, scoreDeadline));
      const results = [];
      for (const id of ids) {
        const snap = await admin.firestore().doc(`students/${id}`).get();
        if (!snap.exists) { results.push({ id, ok: false, skipped: "not-found" }); continue; }
        const s = snap.data();
        if (s.isTest) { results.push({ id, name: s.name, ok: false, skipped: "test-account" }); continue; }
        if (s.notifyExcluded) { results.push({ id, name: s.name, ok: false, skipped: "notify-excluded" }); continue; }
        const phone = String(notifyPhone(s)).replace(/\D/g, "");
        if (phone.length < 9) { results.push({ id, name: s.name, ok: false, skipped: "no-phone" }); continue; }
        try {
          const r = await sendAlimtalk("scoreInputReminder", {
            phone,
            name: s.name || "",
            school: s.school || "",
            grade: s.grade || "",
            seat: s.seat ?? "",
            examName,
            scoreDeadline,
            daysLeft: String(daysLeft),
          });
          results.push({ id, name: s.name, ok: true, result: r });
        } catch (err) {
          console.error(`[scoreInputReminder] ${s.name}(${id}) 발송 실패:`, err);
          results.push({ id, name: s.name, ok: false, error: String(err.message || err) });
        }
      }
      const sent = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).length;
      return res.json({ ok: true, sent, failed, results });
    }

    if (action === "sendBookingStarted") {
      const ids = Array.isArray(payload?.studentIds) ? payload.studentIds.filter(Boolean) : [];
      const consultingName = String(payload?.consultingName || "").trim();
      const bookingDeadline = String(payload?.bookingDeadline || "").trim();
      if (ids.length === 0) return res.status(400).json({ error: "studentIds 가 비어있습니다." });
      if (!consultingName || !bookingDeadline) return res.status(400).json({ error: "멘토링명과 마감일이 필요합니다." });
      const results = [];
      for (const id of ids) {
        const snap = await admin.firestore().doc(`students/${id}`).get();
        if (!snap.exists) { results.push({ id, ok: false, skipped: "not-found" }); continue; }
        const s = snap.data();
        if (s.isTest) { results.push({ id, name: s.name, ok: false, skipped: "test-account" }); continue; }
        if (s.notifyExcluded) { results.push({ id, name: s.name, ok: false, skipped: "notify-excluded" }); continue; }
        const phones = notifyPhonesBoth(s);
        if (phones.length === 0) { results.push({ id, name: s.name, ok: false, skipped: "no-phone" }); continue; }
        for (const { phone, role } of phones) {
          try {
            const r = await sendAlimtalk("bookingStarted", {
              phone,
              name: s.name || "",
              school: s.school || "",
              grade: s.grade || "",
              seat: s.seat ?? "",
              consultingName,
              bookingDeadline,
            });
            results.push({ id, name: s.name, role, phone, ok: true, result: r });
          } catch (err) {
            console.error(`[bookingStarted] ${s.name}(${id}/${role}) 발송 실패:`, err);
            results.push({ id, name: s.name, role, phone, ok: false, error: String(err.message || err) });
          }
        }
      }
      const sent = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok).length;
      return res.json({ ok: true, sent, failed, results });
    }

    if (action === "sendBookingReminder") {
      const ids = Array.isArray(payload?.studentIds) ? payload.studentIds.filter(Boolean) : [];
      const consultingName = String(payload?.consultingName || "").trim();
      const bookingDeadline = String(payload?.bookingDeadline || "").trim();
      if (ids.length === 0) return res.status(400).json({ error: "studentIds 가 비어있습니다." });
      if (!consultingName || !bookingDeadline) return res.status(400).json({ error: "멘토링명과 예약 마감일이 필요합니다." });
      const results = [];
      let alreadyBooked = 0;
      for (const id of ids) {
        const snap = await admin.firestore().doc(`students/${id}`).get();
        if (!snap.exists) { results.push({ id, ok: false, skipped: "not-found" }); continue; }
        const s = snap.data();
        if (s.isTest) { results.push({ id, name: s.name, ok: false, skipped: "test-account" }); continue; }
        if (s.notifyExcluded) { results.push({ id, name: s.name, ok: false, skipped: "notify-excluded" }); continue; }
        const phone = String(notifyPhone(s)).replace(/\D/g, "");
        if (phone.length < 9) { results.push({ id, name: s.name, ok: false, skipped: "no-phone" }); continue; }
        // 이미 예약한 학생은 제외
        const bookingSnap = await admin.firestore().collection("bookings")
          .where("studentId", "==", id).limit(1).get();
        if (!bookingSnap.empty) { alreadyBooked += 1; results.push({ id, name: s.name, ok: false, skipped: "already-booked" }); continue; }
        try {
          const r = await sendAlimtalk("bookingReminder", {
            phone,
            name: s.name || "",
            school: s.school || "",
            grade: s.grade || "",
            seat: s.seat ?? "",
            consultingName,
            bookingDeadline,
          });
          results.push({ id, name: s.name, ok: true, result: r });
        } catch (err) {
          console.error(`[bookingReminder] ${s.name}(${id}) 발송 실패:`, err);
          results.push({ id, name: s.name, ok: false, error: String(err.message || err) });
        }
      }
      const sent = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok && r.skipped !== "already-booked").length;
      return res.json({ ok: true, sent, failed, alreadyBooked, results });
    }

    if (action === "sendConsultUpcoming") {
      const ids = Array.isArray(payload?.studentIds) ? payload.studentIds.filter(Boolean) : [];
      if (ids.length === 0) return res.status(400).json({ error: "studentIds 가 비어있습니다." });
      const today = todayStrKST();
      const results = [];
      let noBooking = 0;
      let pastBooking = 0;
      for (const id of ids) {
        const snap = await admin.firestore().doc(`students/${id}`).get();
        if (!snap.exists) { results.push({ id, ok: false, skipped: "not-found" }); continue; }
        const s = snap.data();
        if (s.isTest) { results.push({ id, name: s.name, ok: false, skipped: "test-account" }); continue; }
        if (s.notifyExcluded) { results.push({ id, name: s.name, ok: false, skipped: "notify-excluded" }); continue; }
        const bookingSnap = await admin.firestore().collection("bookings")
          .where("studentId", "==", id).limit(1).get();
        if (bookingSnap.empty) { noBooking += 1; results.push({ id, name: s.name, ok: false, skipped: "no-booking" }); continue; }
        const b = bookingSnap.docs[0].data();
        const bookingDate = String(b.date || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate)) { results.push({ id, name: s.name, ok: false, skipped: "invalid-booking-date" }); continue; }
        const daysLeft = daysBetween(today, bookingDate);
        if (daysLeft < 0) { pastBooking += 1; results.push({ id, name: s.name, ok: false, skipped: "past-booking" }); continue; }
        const phones = notifyPhonesBoth(s);
        if (phones.length === 0) { results.push({ id, name: s.name, ok: false, skipped: "no-phone" }); continue; }
        for (const { phone, role } of phones) {
          try {
            const r = await sendAlimtalk("consultUpcoming", {
              phone,
              name: s.name || "",
              school: s.school || "",
              grade: s.grade || "",
              seat: s.seat ?? "",
              dateLabel: b.dateLabel || "",
              slot: b.slot || "",
              daysLeft: String(daysLeft),
            });
            results.push({ id, name: s.name, role, phone, ok: true, result: r });
          } catch (err) {
            console.error(`[consultUpcoming] ${s.name}(${id}/${role}) 발송 실패:`, err);
            results.push({ id, name: s.name, role, phone, ok: false, error: String(err.message || err) });
          }
        }
      }
      const sent = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok && r.skipped !== "no-booking" && r.skipped !== "past-booking").length;
      return res.json({ ok: true, sent, failed, noBooking, pastBooking, results });
    }

    if (action === "sendAdminAccountInfo") {
      const targetAdminId = String(payload?.adminAccountId || "").trim();
      const phoneRaw = String(payload?.phone || "").replace(/\D/g, "");
      if (!targetAdminId) return res.status(400).json({ error: "adminAccountId 가 필요합니다." });
      if (phoneRaw.length < 9) return res.status(400).json({ error: "올바른 수신 번호가 필요합니다." });
      const snap = await admin.firestore().doc(`admins/${targetAdminId}`).get();
      if (!snap.exists) return res.status(404).json({ error: "관리자 계정을 찾을 수 없습니다." });
      const a = snap.data();
      if (a.role === "test") return res.status(400).json({ error: "TEST 계정은 발송 대상이 아닙니다." });
      await sendAlimtalk("adminAccountCreated", {
        phone: phoneRaw,
        name: a.name || "",
        accountId: a.id || targetAdminId,
        accountPw: a.password || "",
      });
      return res.json({ ok: true, name: a.name || "", id: targetAdminId });
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
        if (s.notifyExcluded) { results.push({ id, name: s.name, ok: false, skipped: "notify-excluded" }); continue; }
        const phones = notifyPhonesBoth(s);
        if (phones.length === 0) { results.push({ id, name: s.name, ok: false, skipped: "no-phone" }); continue; }
        for (const { phone, role } of phones) {
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
            results.push({ id, name: s.name, role, phone, ok: true, result: r });
          } catch (err) {
            console.error(`[accountCreated] ${s.name}(${id}/${role}) 발송 실패:`, err);
            results.push({ id, name: s.name, role, phone, ok: false, error: String(err.message || err) });
          }
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
        consultingName: "6월 모의평가 멘토링",
        bookingDeadline: "5월 30일 (금)",
      });
      return res.json({ ok: true, result });
    }

    return res.status(400).json({ error: "알 수 없는 action" });
  } catch (err) {
    console.error("ppurioAdmin 오류:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});
