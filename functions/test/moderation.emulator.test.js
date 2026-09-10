"use strict";

/** 자유게시판 제재. `npm run test:emu` 로 실행 (Firestore 에뮬레이터 필요). */

const HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const PROJECT = process.env.GCLOUD_PROJECT || "consulting-token-test";

process.env.FIRESTORE_EMULATOR_HOST = HOST;

const admin = require("firebase-admin");
const moderation = require("../moderation");

const app = admin.apps.length ? admin.apps[0] : admin.initializeApp({ projectId: PROJECT }, "moderation");
const fs = app.firestore();

async function wipe() {
  await fetch(
    `http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }
  );
}

const by = { id: "admin1", name: "김재희" };

beforeAll(async () => {
  await fs.doc("probe/ping").get();
});
beforeEach(wipe);

describe("영구 이용정지", () => {
  test("정지하면 banned 가 서고 이력이 남는다", async () => {
    const r = await moderation.banBoard(fs, { studentId: "stu1", reason: "타인 비방", by });
    expect(r).toEqual({ banned: true, postDeleted: false });
    const ban = await moderation.getBan(fs, "stu1");
    expect(ban).toMatchObject({ banned: true, reason: "타인 비방", byName: "김재희" });
    expect(ban.history).toHaveLength(1);
    expect(ban.history[0]).toMatchObject({ type: "ban", reason: "타인 비방" });
    expect(moderation.isBanned(ban)).toBe(true);
  });

  test("사유 없이는 정지할 수 없다", async () => {
    await expect(moderation.banBoard(fs, { studentId: "stu1", reason: "  ", by }))
      .rejects.toMatchObject({ status: 400 });
    expect(await moderation.getBan(fs, "stu1")).toBeNull();
  });

  test("이미 정지된 학생을 또 정지하면 거부한다", async () => {
    await moderation.banBoard(fs, { studentId: "stu1", reason: "명예훼손", by });
    await expect(moderation.banBoard(fs, { studentId: "stu1", reason: "또", by }))
      .rejects.toMatchObject({ status: 409 });
    const ban = await moderation.getBan(fs, "stu1");
    expect(ban.history).toHaveLength(1);
  });

  test("동시에 두 번 눌러도 이력이 하나만 쌓인다", async () => {
    const out = await Promise.allSettled([
      moderation.banBoard(fs, { studentId: "stu1", reason: "비방", by }),
      moderation.banBoard(fs, { studentId: "stu1", reason: "비방", by }),
    ]);
    expect(out.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const ban = await moderation.getBan(fs, "stu1");
    expect(ban.banned).toBe(true);
    expect(ban.history).toHaveLength(1);
  });
});

describe("사유가 된 글 삭제", () => {
  const post = { authorId: "stu1", title: "문제의 글", body: "비방 내용", photos: [{ path: "a" }, { path: "b" }], createdAt: 1700000000000 };

  test("정지하면 그 글이 지워지고 내용은 이력에 남는다", async () => {
    await fs.doc("posts/p1").set(post);
    const r = await moderation.banBoard(fs, { studentId: "stu1", reason: "타인 비방", by, postId: "p1" });
    expect(r).toEqual({ banned: true, postDeleted: true });
    expect((await fs.doc("posts/p1").get()).exists).toBe(false);
    const ban = await moderation.getBan(fs, "stu1");
    expect(ban.history[0].post).toMatchObject({ id: "p1", title: "문제의 글", body: "비방 내용", photos: 2 });
  });

  test("남의 글은 지우지 않는다", async () => {
    await fs.doc("posts/p1").set({ ...post, authorId: "stu2" });
    const r = await moderation.banBoard(fs, { studentId: "stu1", reason: "비방", by, postId: "p1" });
    expect(r).toEqual({ banned: true, postDeleted: false });
    expect((await fs.doc("posts/p1").get()).exists).toBe(true);
    expect((await moderation.getBan(fs, "stu1")).history[0].post).toBeUndefined();
  });

  test("이미 지워진 글이어도 정지는 된다", async () => {
    const r = await moderation.banBoard(fs, { studentId: "stu1", reason: "비방", by, postId: "gone" });
    expect(r).toEqual({ banned: true, postDeleted: false });
    expect(moderation.isBanned(await moderation.getBan(fs, "stu1"))).toBe(true);
  });

  test("정지가 거부되면 글도 그대로 남는다", async () => {
    await moderation.banBoard(fs, { studentId: "stu1", reason: "1차", by });
    await fs.doc("posts/p1").set(post);
    await expect(moderation.banBoard(fs, { studentId: "stu1", reason: "2차", by, postId: "p1" }))
      .rejects.toMatchObject({ status: 409 });
    expect((await fs.doc("posts/p1").get()).exists).toBe(true);
  });

  test("긴 본문은 잘라서 남긴다", async () => {
    await fs.doc("posts/p1").set({ ...post, body: "가".repeat(900) });
    await moderation.banBoard(fs, { studentId: "stu1", reason: "비방", by, postId: "p1" });
    const ban = await moderation.getBan(fs, "stu1");
    expect(ban.history[0].post.body).toHaveLength(500);
  });
});

describe("정지 해제", () => {
  test("해제하면 풀리지만 이력은 남는다", async () => {
    await moderation.banBoard(fs, { studentId: "stu1", reason: "오인", by });
    const r = await moderation.unbanBoard(fs, { studentId: "stu1", reason: "잘못 처리", by });
    expect(r).toEqual({ banned: false });
    const ban = await moderation.getBan(fs, "stu1");
    expect(moderation.isBanned(ban)).toBe(false);
    expect(ban.history.map((h) => h.type)).toEqual(["ban", "unban"]);
    expect(ban.history[1].reason).toBe("잘못 처리");
  });

  test("정지 상태가 아니면 해제할 수 없다", async () => {
    await expect(moderation.unbanBoard(fs, { studentId: "stu1", by }))
      .rejects.toMatchObject({ status: 409 });
  });

  test("해제한 뒤에는 다시 정지할 수 있다", async () => {
    await moderation.banBoard(fs, { studentId: "stu1", reason: "1차", by });
    await moderation.unbanBoard(fs, { studentId: "stu1", by });
    await moderation.banBoard(fs, { studentId: "stu1", reason: "2차", by });
    const ban = await moderation.getBan(fs, "stu1");
    expect(ban.banned).toBe(true);
    expect(ban.reason).toBe("2차");
    expect(ban.history).toHaveLength(3);
  });
});

describe("isBanned", () => {
  test("기록이 없거나 해제 상태면 false", () => {
    expect(moderation.isBanned(null)).toBe(false);
    expect(moderation.isBanned({})).toBe(false);
    expect(moderation.isBanned({ banned: false })).toBe(false);
    expect(moderation.isBanned({ banned: true })).toBe(true);
  });
});
