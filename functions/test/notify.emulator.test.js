"use strict";

/**
 * 알림톡 서비스 레이어 — 재시도·로그·드라이런.
 * ppurio 모듈을 갈아끼워 실제 발송 없이 검증한다. `npm run test:emu` 로 실행.
 */

const HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT || "consulting-token-test";
process.env.FIRESTORE_EMULATOR_HOST = HOST;

const admin = require("firebase-admin");

// notify 가 require 하기 전에 뿌리오를 가짜로 바꾼다.
jest.mock("../ppurio", () => ({
  sendAlimtalk: jest.fn(),
  sendAlimtalkToAdmins: jest.fn(),
}));
const ppurio = require("../ppurio");
const notify = require("../notify");

// notify.js 는 admin.firestore()(기본 앱)를 쓰므로 이름 붙은 앱이 아니라 기본 앱을 띄운다.
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const fs = admin.firestore();

async function wipe() {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
}
async function logs() {
  const snap = await fs.collection(notify.LOG_COLLECTION).get();
  return snap.docs.map((d) => d.data());
}

beforeAll(async () => { await fs.doc("probe/ping").get(); });
beforeEach(async () => {
  await wipe();
  jest.clearAllMocks();
  delete process.env.ALIMTALK_DRY_RUN;
});

const OK_VARS = { var1: "5개", var2: "12개" };

describe("변수 검증", () => {
  test("빈 변수가 있으면 발송하지 않고 로그만 남긴다", async () => {
    await notify.notify("tokenCharged", {
      to: "student", phone: "01012345678", name: "김승찬",
      vars: { var1: "5개", var2: "" },
    });
    expect(ppurio.sendAlimtalk).not.toHaveBeenCalled();
    const l = await logs();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ status: "skipped", eventKey: "tokenCharged" });
    expect(l[0].error).toContain("var2");
  });

  test("학생 연락처가 없으면 발송하지 않는다", async () => {
    await notify.notify("tokenCharged", { to: "student", phone: "", name: "김승찬", vars: OK_VARS });
    expect(ppurio.sendAlimtalk).not.toHaveBeenCalled();
    const l = await logs();
    expect(l[0]).toMatchObject({ status: "skipped" });
    expect(l[0].error).toContain("연락처");
  });
});

describe("발송과 로그", () => {
  test("성공하면 sent 로 남고 번호는 가려진다", async () => {
    ppurio.sendAlimtalk.mockResolvedValue({ code: "200" });
    await notify.notify("tokenCharged", { to: "student", phone: "010-1234-5678", name: "김승찬", vars: OK_VARS });
    expect(ppurio.sendAlimtalk).toHaveBeenCalledTimes(1);
    const l = await logs();
    expect(l[0]).toMatchObject({
      status: "sent", eventKey: "tokenCharged", recipient: "010****5678",
      recipientName: "김승찬", responseCode: "200", attempts: 1,
    });
    expect(l[0].vars).toEqual(OK_VARS);
  });

  test("관리자 발송은 sendAlimtalkToAdmins 로 간다", async () => {
    ppurio.sendAlimtalkToAdmins.mockResolvedValue({ admins: [] });
    await notify.notify("adminNotifyTokenRequest", { to: "admins", name: "김승찬", vars: { var1: "김승찬" } });
    expect(ppurio.sendAlimtalkToAdmins).toHaveBeenCalledTimes(1);
    expect(ppurio.sendAlimtalk).not.toHaveBeenCalled();
    expect((await logs())[0]).toMatchObject({ status: "sent", recipientType: "admins" });
  });
});

describe("재시도", () => {
  test("실패하면 최대 3회까지 다시 보낸다", async () => {
    ppurio.sendAlimtalk
      .mockRejectedValueOnce(new Error("일시 오류"))
      .mockRejectedValueOnce(new Error("일시 오류"))
      .mockResolvedValue({ code: "200" });
    await notify.notify("tokenCharged", { to: "student", phone: "01012345678", name: "김승찬", vars: OK_VARS });
    expect(ppurio.sendAlimtalk).toHaveBeenCalledTimes(3);
    expect((await logs())[0]).toMatchObject({ status: "sent", attempts: 3 });
  });

  test("3회 모두 실패하면 failed 로 남기고 throw 하지 않는다", async () => {
    ppurio.sendAlimtalk.mockRejectedValue(new Error("게이트웨이 오류"));
    await expect(notify.notify("tokenCharged", {
      to: "student", phone: "01012345678", name: "김승찬", vars: OK_VARS,
    })).resolves.toBeUndefined();
    expect(ppurio.sendAlimtalk).toHaveBeenCalledTimes(notify.MAX_ATTEMPTS);
    const l = await logs();
    expect(l[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect(l[0].error).toContain("게이트웨이");
  });
});

describe("드라이런", () => {
  test("플래그가 켜져 있으면 실제로 보내지 않는다", async () => {
    process.env.ALIMTALK_DRY_RUN = "1";
    await notify.notify("tokenCharged", { to: "student", phone: "01012345678", name: "김승찬", vars: OK_VARS });
    expect(ppurio.sendAlimtalk).not.toHaveBeenCalled();
    expect((await logs())[0]).toMatchObject({ status: "dryrun" });
  });
});

describe("새 질문 등록 알림", () => {
  async function makeQuestion(status) {
    await fs.collection("questions").add({ status, title: "t", body: "b", createdAt: Date.now() });
  }

  test("미답변은 전체 학생 기준으로 센다", async () => {
    ppurio.sendAlimtalkToAdmins.mockResolvedValue({ code: "200" });
    await makeQuestion("pending");
    await makeQuestion("pending");
    await makeQuestion("answered");
    await notify.notifyQuestionCreated({ studentName: "김승찬", createdAt: Date.UTC(2026, 8, 8, 0, 30) });

    const ctx = ppurio.sendAlimtalkToAdmins.mock.calls[0][1];
    expect(ctx).toMatchObject({ var1: "김승찬", var2: "2026-09-08 09:30", var3: "2", var4: "3" });
  });

  test("스레드가 하나뿐이어도 숫자가 비지 않는다", async () => {
    ppurio.sendAlimtalkToAdmins.mockResolvedValue({ code: "200" });
    await makeQuestion("pending");
    await notify.notifyQuestionCreated({ studentName: "김승찬", createdAt: Date.now() });
    const ctx = ppurio.sendAlimtalkToAdmins.mock.calls[0][1];
    expect(ctx.var3).toBe("1");
    expect(ctx.var4).toBe("1");
  });
});

describe("트리거 진입점", () => {
  test("토큰 충전 완료는 학생에게만 간다", async () => {
    ppurio.sendAlimtalk.mockResolvedValue({ code: "200" });
    await notify.notifyTokenCharged({ studentName: "김승찬", phone: "01012345678", charged: 11, balance: 18 });
    expect(ppurio.sendAlimtalkToAdmins).not.toHaveBeenCalled();
    const ctx = ppurio.sendAlimtalk.mock.calls[0][1];
    expect(ctx).toMatchObject({ var1: "11개", var2: "18개", name: "김승찬" });
  });

  test("결제 요청 접수는 학교가 비면 보내지 않는다", async () => {
    await notify.notifyTokenPaymentRequested({
      studentName: "김승찬", school: "", grade: "고3", tokens: 10, amount: 10000, requestedAt: Date.now(),
    });
    expect(ppurio.sendAlimtalkToAdmins).not.toHaveBeenCalled();
    expect((await logs())[0].error).toContain("var2");
  });

  test("결제 요청 접수 금액은 원화로 나간다", async () => {
    ppurio.sendAlimtalkToAdmins.mockResolvedValue({ code: "200" });
    await notify.notifyTokenPaymentRequested({
      studentName: "김승찬", school: "가나고", grade: "고3",
      tokens: 10, amount: 10000, requestedAt: Date.UTC(2026, 8, 8, 0, 30),
    });
    const ctx = ppurio.sendAlimtalkToAdmins.mock.calls[0][1];
    expect(ctx).toMatchObject({ var4: "10개", var5: "10,000원", var6: "2026-09-08 09:30" });
  });
});
