"use strict";

/**
 * 토큰 차감·지급 트랜잭션 테스트.
 *
 * Firestore 에뮬레이터 위에서만 돈다 — `npm run test:emu` 로 실행할 것.
 * (`npm test` 는 이 파일을 건너뛰고 순수 계산 테스트만 돌린다.)
 * 동시성과 멱등성은 실제 트랜잭션 재시도가 걸린 문제라 가짜 Firestore 로는 검증이 되지 않는다.
 */

const HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT || "consulting-token-test";

process.env.FIRESTORE_EMULATOR_HOST = HOST;

const admin = require("firebase-admin");
const tokens = require("../tokens");

admin.initializeApp({ projectId: PROJECT });
const fs = admin.firestore();

async function wipe() {
  await fetch(
    `http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }
  );
}

const student = { id: "stu1", name: "김승찬", grade: "고3", phone: "010-1111-2222" };
const adminActor = { id: "admin1", name: "김재희", role: "admin" };

async function setPolicy(patch) {
  await fs.doc(tokens.POLICY_DOC).set(
    { signupGrant: 1, questionCost: 1, unitPrice: 1000, packages: [], ...patch },
    { merge: false }
  );
}
async function setBalance(id, n) {
  await fs.doc(`tokenBalances/${id}`).set({ balance: n, updatedAt: Date.now() });
}
async function ledgerFor(id) {
  const snap = await fs.collection("tokenLedger").where("studentId", "==", id).get();
  return snap.docs.map((d) => d.data());
}

beforeAll(async () => {
  // 에뮬레이터가 없으면 조용히 통과시키지 말고 여기서 터뜨린다.
  await fs.doc("probe/ping").get();
});

beforeEach(async () => {
  await wipe();
  await setPolicy({});
});

describe("신규 학생 기본 지급", () => {
  test("기본 지급량만큼 잔액이 생기고 원장에 남는다", async () => {
    await setPolicy({ signupGrant: 3 });
    const r = await tokens.grantSignupTokens(fs, "stuA");
    expect(r).toEqual({ granted: true, balance: 3 });
    const led = await ledgerFor("stuA");
    expect(led).toHaveLength(1);
    expect(led[0]).toMatchObject({ delta: 3, reason: "signup", balanceAfter: 3 });
  });

  test("두 번 호출해도 한 번만 지급한다 (트리거 재시도 대비)", async () => {
    await setPolicy({ signupGrant: 3 });
    await tokens.grantSignupTokens(fs, "stuA");
    const second = await tokens.grantSignupTokens(fs, "stuA");
    expect(second.granted).toBe(false);
    expect(await tokens.getBalance(fs, "stuA")).toBe(3);
    expect(await ledgerFor("stuA")).toHaveLength(1);
  });

  test("동시에 두 번 들어와도 한 번만 지급한다", async () => {
    await setPolicy({ signupGrant: 5 });
    await Promise.allSettled([
      tokens.grantSignupTokens(fs, "stuA"),
      tokens.grantSignupTokens(fs, "stuA"),
    ]);
    expect(await tokens.getBalance(fs, "stuA")).toBe(5);
    expect(await ledgerFor("stuA")).toHaveLength(1);
  });
});

describe("질문 작성 토큰 차감", () => {
  test("정상 작성하면 차감되고 원장이 남는다", async () => {
    await setPolicy({ questionCost: 2 });
    await setBalance(student.id, 5);
    const r = await tokens.createQuestion(fs, { student, title: "미적분", body: "29번" });
    expect(r.balance).toBe(3);
    expect(await tokens.getBalance(fs, student.id)).toBe(3);
    const led = await ledgerFor(student.id);
    expect(led).toHaveLength(1);
    expect(led[0]).toMatchObject({ delta: -2, reason: "question", refId: r.id, balanceAfter: 3 });
    const q = await fs.doc(`questions/${r.id}`).get();
    expect(q.data()).toMatchObject({ status: "pending", authorId: student.id, tokenCost: 2 });
  });

  test("잔액이 모자라면 402 로 거부하고 아무것도 바꾸지 않는다", async () => {
    await setPolicy({ questionCost: 3 });
    await setBalance(student.id, 2);
    await expect(
      tokens.createQuestion(fs, { student, title: "t", body: "b" })
    ).rejects.toMatchObject({ status: 402 });
    expect(await tokens.getBalance(fs, student.id)).toBe(2);
    expect(await ledgerFor(student.id)).toHaveLength(0);
    expect((await fs.collection("questions").get()).size).toBe(0);
  });

  test("잔액 0 에서는 작성할 수 없다", async () => {
    await setBalance(student.id, 0);
    await expect(
      tokens.createQuestion(fs, { student, title: "t", body: "b" })
    ).rejects.toMatchObject({ status: 402 });
  });

  test("동시에 몰려도 잔액보다 많이 작성되지 않고 음수로 내려가지 않는다", async () => {
    await setPolicy({ questionCost: 1 });
    await setBalance(student.id, 3);
    const tries = Array.from({ length: 8 }, (_, i) =>
      tokens.createQuestion(fs, { student, title: `q${i}`, body: "b" })
    );
    const out = await Promise.allSettled(tries);
    const ok = out.filter((r) => r.status === "fulfilled");
    const failed = out.filter((r) => r.status === "rejected");

    expect(ok).toHaveLength(3);
    expect(failed).toHaveLength(5);
    failed.forEach((f) => expect(f.reason.status).toBe(402));

    const bal = await tokens.getBalance(fs, student.id);
    expect(bal).toBe(0);
    expect(bal).toBeGreaterThanOrEqual(0);
    expect((await fs.collection("questions").get()).size).toBe(3);
    expect(await ledgerFor(student.id)).toHaveLength(3);
  });

  test("제목이나 내용이 비면 거부한다", async () => {
    await setBalance(student.id, 5);
    await expect(tokens.createQuestion(fs, { student, title: " ", body: "b" }))
      .rejects.toMatchObject({ status: 400 });
    await expect(tokens.createQuestion(fs, { student, title: "t", body: "  " }))
      .rejects.toMatchObject({ status: 400 });
    expect(await tokens.getBalance(fs, student.id)).toBe(5);
  });
});

describe("관리자 수동 증감", () => {
  test("증가와 감소가 원장에 남는다", async () => {
    await setBalance(student.id, 2);
    await tokens.adjustTokens(fs, { studentId: student.id, delta: 5, note: "이벤트", by: adminActor });
    expect(await tokens.getBalance(fs, student.id)).toBe(7);
    await tokens.adjustTokens(fs, { studentId: student.id, delta: -3, by: adminActor });
    expect(await tokens.getBalance(fs, student.id)).toBe(4);
    const led = await ledgerFor(student.id);
    expect(led.map((l) => l.delta).sort((a, b) => a - b)).toEqual([-3, 5]);
    expect(led.every((l) => l.reason === "manual")).toBe(true);
  });

  test("잔액보다 많이 차감하려 하면 거부한다", async () => {
    await setBalance(student.id, 2);
    await expect(
      tokens.adjustTokens(fs, { studentId: student.id, delta: -5, by: adminActor })
    ).rejects.toMatchObject({ status: 400 });
    expect(await tokens.getBalance(fs, student.id)).toBe(2);
  });
});

describe("질문 댓글 권한", () => {
  async function makeQuestion() {
    await setBalance(student.id, 5);
    return (await tokens.createQuestion(fs, { student, title: "t", body: "b" })).id;
  }

  test("남의 질문에는 학생이 댓글을 달 수 없다", async () => {
    const id = await makeQuestion();
    await expect(
      tokens.addQuestionComment(fs, {
        questionId: id, actor: { id: "other", name: "남", role: "student" }, body: "끼어들기",
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  test("본인 질문에는 댓글을 달 수 있고 상태는 그대로다", async () => {
    const id = await makeQuestion();
    await tokens.addQuestionComment(fs, {
      questionId: id, actor: { id: student.id, name: student.name, role: "student" }, body: "추가로",
    });
    const q = (await fs.doc(`questions/${id}`).get()).data();
    expect(q.comments).toHaveLength(1);
    expect(q.status).toBe("pending");
  });

  test("관리자가 댓글을 달면 답변완료로 바뀐다", async () => {
    const id = await makeQuestion();
    await tokens.addQuestionComment(fs, { questionId: id, actor: adminActor, body: "이렇게 푸세요" });
    const q = (await fs.doc(`questions/${id}`).get()).data();
    expect(q.status).toBe("answered");
    expect(typeof q.answeredAt).toBe("number");
  });

  test("학생은 자기 댓글만 지울 수 있다", async () => {
    const id = await makeQuestion();
    await tokens.addQuestionComment(fs, {
      questionId: id, actor: { id: student.id, name: student.name, role: "student" }, body: "내 댓글",
    });
    const cid = (await fs.doc(`questions/${id}`).get()).data().comments[0]._id;

    await expect(tokens.deleteQuestionComment(fs, {
      questionId: id, commentId: cid, actor: { id: "other", name: "남", role: "student" },
    })).rejects.toMatchObject({ status: 403 });

    await tokens.deleteQuestionComment(fs, {
      questionId: id, commentId: cid, actor: { id: student.id, name: student.name, role: "student" },
    });
    expect((await fs.doc(`questions/${id}`).get()).data().comments).toHaveLength(0);
  });

  test("관리자 댓글이 모두 지워지면 답변대기로 되돌아간다", async () => {
    const id = await makeQuestion();
    await tokens.addQuestionComment(fs, { questionId: id, actor: adminActor, body: "답변" });
    expect((await fs.doc(`questions/${id}`).get()).data().status).toBe("answered");
    const cid = (await fs.doc(`questions/${id}`).get()).data().comments[0]._id;
    await tokens.deleteQuestionComment(fs, { questionId: id, commentId: cid, actor: adminActor });
    const q = (await fs.doc(`questions/${id}`).get()).data();
    expect(q.status).toBe("pending");
    expect(q.answeredAt).toBeNull();
  });

  test("없는 댓글을 지우려 하면 404", async () => {
    const id = await makeQuestion();
    await expect(tokens.deleteQuestionComment(fs, {
      questionId: id, commentId: "nope", actor: adminActor,
    })).rejects.toMatchObject({ status: 404 });
  });

  test("댓글은 토큰을 쓰지 않는다", async () => {
    const id = await makeQuestion();
    const before = await tokens.getBalance(fs, student.id);
    await tokens.addQuestionComment(fs, {
      questionId: id, actor: { id: student.id, name: student.name, role: "student" }, body: "무료",
    });
    expect(await tokens.getBalance(fs, student.id)).toBe(before);
  });
});

describe("결제 요청 흐름", () => {
  const PKG = [{ id: "p10", tokens: 10, order: 1, discountType: "percent", discountValue: 10 }];

  async function requested() {
    await setPolicy({ unitPrice: 1000, packages: PKG });
    return (await tokens.createPaymentRequest(fs, { student, packageId: "p10" })).id;
  }

  test("요청 시점 금액을 스냅샷으로 박아 둔다", async () => {
    const id = await requested();
    await setPolicy({ unitPrice: 5000, packages: PKG }); // 나중에 단가를 올려도
    const pr = (await fs.doc(`paymentRequests/${id}`).get()).data();
    expect(pr).toMatchObject({ status: "requested", tokens: 10, unitPrice: 1000, amount: 9000 });
  });

  test("요청됨 → 발송완료 → 결제완료 순서로만 넘어간다", async () => {
    const id = await requested();
    await expect(tokens.markPaymentPaid(fs, { requestId: id, by: adminActor }))
      .rejects.toMatchObject({ status: 409 });
    await tokens.markPaymentSent(fs, { requestId: id, by: adminActor });
    await expect(tokens.markPaymentSent(fs, { requestId: id, by: adminActor }))
      .rejects.toMatchObject({ status: 409 });
    await tokens.markPaymentPaid(fs, { requestId: id, by: adminActor });
    expect(await tokens.getBalance(fs, student.id)).toBe(10);
  });

  test("결제 완료를 두 번 눌러도 한 번만 지급한다", async () => {
    const id = await requested();
    await tokens.markPaymentSent(fs, { requestId: id, by: adminActor });
    await tokens.markPaymentPaid(fs, { requestId: id, by: adminActor });
    await expect(tokens.markPaymentPaid(fs, { requestId: id, by: adminActor }))
      .rejects.toMatchObject({ status: 409 });
    expect(await tokens.getBalance(fs, student.id)).toBe(10);
    expect(await ledgerFor(student.id)).toHaveLength(1);
  });

  test("동시에 두 번 눌러도 한 번만 지급한다", async () => {
    const id = await requested();
    await tokens.markPaymentSent(fs, { requestId: id, by: adminActor });
    const out = await Promise.allSettled([
      tokens.markPaymentPaid(fs, { requestId: id, by: adminActor }),
      tokens.markPaymentPaid(fs, { requestId: id, by: adminActor }),
    ]);
    expect(out.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await tokens.getBalance(fs, student.id)).toBe(10);
    expect(await ledgerFor(student.id)).toHaveLength(1);
  });

  test("보너스가 붙은 상품은 보너스까지 지급된다", async () => {
    await setPolicy({ unitPrice: 1000, packages: [{ id: "b10", tokens: 10, bonus: 1, order: 1 }] });
    const id = (await tokens.createPaymentRequest(fs, { student, packageId: "b10" })).id;
    const pr = (await fs.doc(`paymentRequests/${id}`).get()).data();
    expect(pr).toMatchObject({ tokens: 10, bonus: 1, totalTokens: 11, amount: 10000 });

    await tokens.markPaymentSent(fs, { requestId: id, by: adminActor });
    await tokens.markPaymentPaid(fs, { requestId: id, by: adminActor });
    expect(await tokens.getBalance(fs, student.id)).toBe(11);
    const led = await ledgerFor(student.id);
    expect(led[0]).toMatchObject({ delta: 11, reason: "purchase" });
    expect(led[0].note).toContain("보너스");
  });

  test("결제 완료된 요청은 취소할 수 없다", async () => {
    const id = await requested();
    await tokens.markPaymentSent(fs, { requestId: id, by: adminActor });
    await tokens.markPaymentPaid(fs, { requestId: id, by: adminActor });
    await expect(tokens.cancelPaymentRequest(fs, { requestId: id, by: adminActor, actor: adminActor }))
      .rejects.toMatchObject({ status: 409 });
  });

  test("남의 결제 요청은 학생이 취소할 수 없다", async () => {
    const id = await requested();
    await expect(
      tokens.cancelPaymentRequest(fs, {
        requestId: id, by: { id: "other", name: "남" },
        actor: { id: "other", name: "남", role: "student" },
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  test("비활성 상품은 요청할 수 없다", async () => {
    await setPolicy({ unitPrice: 1000, packages: [{ id: "off", tokens: 5, active: false }] });
    await expect(tokens.createPaymentRequest(fs, { student, packageId: "off" }))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe("기존 학생 일괄 지급", () => {
  test("잔액 문서가 없는 학생에게만 채워 준다", async () => {
    await setPolicy({ signupGrant: 2 });
    await fs.doc("students/s1").set({ name: "가" });
    await fs.doc("students/s2").set({ name: "나" });
    await fs.doc("students/s3").set({ name: "퇴원", withdrawn: true });
    await setBalance("s1", 7);

    const r = await tokens.backfillSignupGrants(fs, { by: adminActor });
    expect(r.granted).toBe(1);
    expect(await tokens.getBalance(fs, "s1")).toBe(7);
    expect(await tokens.getBalance(fs, "s2")).toBe(2);
    expect(await tokens.getBalance(fs, "s3")).toBe(0);
  });
});
