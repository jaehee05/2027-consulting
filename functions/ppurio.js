const admin = require("firebase-admin");

const TIMEOUT_MS = 10000;
const PROXY_URL = process.env.PPURIO_PROXY_URL;
const PROXY_SECRET = process.env.PPURIO_PROXY_SECRET;

let memToken = { token: null, expiresAt: 0 };

async function getSettings() {
  const snap = await admin.firestore().doc("settings/ppurio").get();
  if (!snap.exists) throw new Error("settings/ppurio 문서가 없습니다. 관리자 페이지에서 먼저 설정하세요.");
  const d = snap.data();
  if (!d.apiKey || !d.ppurioAccount || !d.senderProfile) {
    throw new Error("뿌리오 계정/API키/발신프로필이 누락되었습니다.");
  }
  return d;
}

async function ppurioFetch(path, headers, body) {
  if (!PROXY_URL || !PROXY_SECRET) {
    throw new Error("PPURIO_PROXY_URL / PPURIO_PROXY_SECRET 환경변수가 설정되지 않았습니다. functions/.env 확인.");
  }
  const res = await fetch(PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Proxy-Secret": PROXY_SECRET },
    body: JSON.stringify({ path, method: "POST", headers: headers || {}, body: body || {} }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { ok: res.ok, status: res.status, body: parsed };
}

async function getToken(settings) {
  const now = Date.now();
  if (memToken.token && memToken.expiresAt > now + 60_000) return memToken.token;

  const persistedSnap = await admin.firestore().doc("settings/ppurio_token").get();
  const persisted = persistedSnap.exists ? persistedSnap.data() : null;
  if (persisted?.token && persisted.expiresAt > now + 60_000) {
    memToken = persisted;
    return persisted.token;
  }

  const basic = Buffer.from(`${settings.ppurioAccount}:${settings.apiKey}`).toString("base64");
  const { ok, status, body } = await ppurioFetch("/v1/token", { Authorization: `Basic ${basic}` }, {});
  if (!ok || !body.token) throw new Error(`토큰 발급 실패 (${status}): ${JSON.stringify(body)}`);

  const expiresAt = now + 23 * 60 * 60 * 1000;
  memToken = { token: body.token, expiresAt };
  await admin.firestore().doc("settings/ppurio_token").set(memToken);
  return body.token;
}

function substitute(tpl, ctx) {
  return String(tpl ?? "").replace(/\$\{(\w+)\}/g, (_, k) => (ctx[k] ?? ""));
}

function randomRefKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`.slice(0, 32);
}

async function sendAlimtalk(eventKey, ctx) {
  const settings = await getSettings();
  if (settings.enabled === false) {
    console.log(`[${eventKey}] 알림톡 비활성화 — 발송 생략`);
    return { skipped: "disabled" };
  }
  const tmpl = settings.templates?.[eventKey];
  if (!tmpl?.code) {
    console.log(`[${eventKey}] 템플릿 미설정 — 발송 생략`);
    return { skipped: "no-template" };
  }
  const phone = String(ctx.phone || "").replace(/\D/g, "");
  if (!phone) {
    console.warn(`[${eventKey}] 전화번호 없음 — name=${ctx.name}`);
    return { skipped: "no-phone" };
  }

  const changeWord = {};
  for (const [k, v] of Object.entries(tmpl.changeWord || {})) {
    changeWord[k] = substitute(v, ctx);
  }

  const token = await getToken(settings);
  const params = {
    account: settings.ppurioAccount,
    messageType: tmpl.messageType || "ALT",
    senderProfile: settings.senderProfile,
    templateCode: tmpl.code,
    duplicateFlag: "Y",
    isResend: "N",
    targetCount: 1,
    targets: [{ to: phone, name: ctx.name || "", changeWord }],
    refKey: randomRefKey(eventKey),
  };

  const { ok, status, body } = await ppurioFetch("/v1/kakao", { Authorization: `Bearer ${token}` }, params);
  console.log(`[${eventKey}] 뿌리오 응답 (${status}):`, JSON.stringify(body));
  if (!ok) throw new Error(`알림톡 발송 실패 (${status}): ${JSON.stringify(body)}`);
  return body;
}

async function sendAlimtalkToAdmins(eventKey, ctx) {
  let settings;
  try { settings = await getSettings(); }
  catch (e) {
    console.log(`[${eventKey}] 관리자 알림 스킵 — 설정 없음: ${e.message}`);
    return { skipped: "no-settings" };
  }
  const phones = Array.isArray(settings.adminPhones)
    ? settings.adminPhones.map((p) => String(p || "").replace(/\D/g, "")).filter((p) => p.length >= 9)
    : [];
  if (phones.length === 0) {
    console.log(`[${eventKey}] 관리자 수신번호 미설정 — 관리자 알림 생략`);
    return { skipped: "no-admin-phones" };
  }
  const results = [];
  for (const phone of phones) {
    try {
      const r = await sendAlimtalk(eventKey, { ...ctx, phone });
      results.push({ phone, ok: true, result: r });
    } catch (err) {
      console.error(`[${eventKey}] 관리자(${phone}) 발송 실패:`, err);
      results.push({ phone, ok: false, error: String(err.message || err) });
    }
  }
  return { admins: results };
}

module.exports = { sendAlimtalk, sendAlimtalkToAdmins };
