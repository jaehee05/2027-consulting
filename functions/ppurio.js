const admin = require("firebase-admin");

const URI = "https://message.ppurio.com";
const TIMEOUT_MS = 10000;

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
  const res = await fetch(`${URI}/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(`토큰 발급 실패 (${res.status}): ${JSON.stringify(body)}`);

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
    messageType: "ALT",
    senderProfile: settings.senderProfile,
    templateCode: tmpl.code,
    duplicateFlag: "Y",
    targetCount: 1,
    targets: [{ to: phone, name: ctx.name || "", changeWord }],
    refKey: randomRefKey(eventKey),
  };

  const res = await fetch(`${URI}/v1/kakao`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`[${eventKey}] 뿌리오 응답 (${res.status}):`, JSON.stringify(body));
  if (!res.ok) throw new Error(`알림톡 발송 실패 (${res.status}): ${JSON.stringify(body)}`);
  return body;
}

module.exports = { sendAlimtalk };
