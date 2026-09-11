"use strict";

/**
 * firestore.rules 검증 — 특히 자유게시판 비밀글.
 * 화면에서 가리는 것과 실제로 못 읽는 것은 다르다. 여기서 확인하는 건 후자다.
 * `npm run test:emu` 로 실행.
 */

const fs = require("fs");
const path = require("path");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");

const HOST = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");

let env;

// loginToken 이 실어 주는 클레임 모양 그대로.
const student = (studentId) => env.authenticatedContext(`stu_${studentId}`, { role: "student", studentId });
const adminCtx = () => env.authenticatedContext("admin_kjh", { role: "admin", loginId: "kjh" });
const opCtx = () => env.authenticatedContext("op_1", { role: "viewer", loginId: "op" });

const OPEN = { secret: false, authorId: "stuA", authorRole: "student", body: "공개글", title: "t" };
const SECRET = { secret: true, authorId: "stuA", authorRole: "student", body: "비밀글", title: "t" };

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "rules-test",
    firestore: {
      host: HOST[0],
      port: Number(HOST[1]),
      rules: fs.readFileSync(path.join(__dirname, "..", "..", "firestore.rules"), "utf8"),
    },
  });
});
afterAll(async () => { if (env) await env.cleanup(); });

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc("posts/open").set(OPEN);
    await db.doc("posts/secret").set(SECRET);
    await db.doc("tokenBalances/stuA").set({ balance: 5 });
    await db.doc("alimtalkLogs/x").set({ eventKey: "e" });
    await db.doc("pushTokens/tok1").set({ role: "admin", ownerId: "admin1" });
    await db.doc("students/stuA").set({ name: "가나다" });
  });
});

describe("자유게시판 비밀글", () => {
  test("남의 비밀글은 학생이 문서를 직접 읽어도 막힌다", async () => {
    const db = student("stuB").firestore();
    await assertFails(db.doc("posts/secret").get());
  });

  test("본인 비밀글은 읽을 수 있다", async () => {
    const db = student("stuA").firestore();
    await assertSucceeds(db.doc("posts/secret").get());
  });

  test("공개글은 누구나 읽을 수 있다", async () => {
    await assertSucceeds(student("stuB").firestore().doc("posts/open").get());
  });

  test("관리자와 OP 는 비밀글도 읽는다", async () => {
    await assertSucceeds(adminCtx().firestore().doc("posts/secret").get());
    await assertSucceeds(opCtx().firestore().doc("posts/secret").get());
  });

  test("학생이 컬렉션을 통째로 구독하면 거부된다", async () => {
    // 막힌 문서가 섞일 수 있어 쿼리 자체가 실패해야 한다. 이게 실패하면 비밀글이 새는 것.
    await assertFails(student("stuB").firestore().collection("posts").get());
  });

  test("앱이 쓰는 두 쿼리(공개글 · 내 글)는 통과한다", async () => {
    const db = student("stuA").firestore();
    await assertSucceeds(db.collection("posts").where("secret", "==", false).get());
    await assertSucceeds(db.collection("posts").where("authorId", "==", "stuA").get());
  });

  test("secret==false 로 걸러도 남의 비밀글은 결과에 없다", async () => {
    const snap = await student("stuB").firestore().collection("posts").where("secret", "==", false).get();
    expect(snap.docs.map((d) => d.id)).toEqual(["open"]);
  });

  test("관리자는 컬렉션을 통째로 읽는다", async () => {
    await assertSucceeds(adminCtx().firestore().collection("posts").get());
  });

  test("로그인하지 않으면 아무것도 못 읽고 못 쓴다", async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(db.doc("posts/open").get());
    await assertFails(db.doc("posts/open").update({ views: 1 }));
  });
});

describe("서버 전용 컬렉션", () => {
  test("학생이 자기 잔액을 못 올린다", async () => {
    await assertFails(student("stuA").firestore().doc("tokenBalances/stuA").set({ balance: 999 }));
  });

  test("관리자도 잔액을 직접 못 쓴다 — tokenApi 만 쓴다", async () => {
    await assertFails(adminCtx().firestore().doc("tokenBalances/stuA").set({ balance: 999 }));
  });

  test("잔액 읽기는 열려 있다", async () => {
    await assertSucceeds(student("stuA").firestore().doc("tokenBalances/stuA").get());
  });

  test("발송 로그는 읽기도 막힌다", async () => {
    await assertFails(student("stuA").firestore().doc("alimtalkLogs/x").get());
    await assertFails(adminCtx().firestore().doc("alimtalkLogs/x").get());
  });

  test("푸시 토큰은 읽기도 막힌다 — 토큰은 그 기기로 알림을 보낼 수 있는 자격증명이다", async () => {
    await assertFails(student("stuA").firestore().doc("pushTokens/tok1").get());
    await assertFails(adminCtx().firestore().doc("pushTokens/tok1").get());
    await assertFails(adminCtx().firestore().doc("pushTokens/tok2").set({ role: "admin" }));
  });

  test("config/tokens 는 쓰기가 막히고 읽기는 열려 있다", async () => {
    const db = adminCtx().firestore();
    await assertFails(db.doc("config/tokens").set({ unitPrice: 1 }));
    await assertSucceeds(db.doc("config/tokens").get());
  });
});
