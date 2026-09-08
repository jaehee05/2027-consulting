"use strict";

// 에뮬레이터 없이 도는 부분 — 변수 검증과 포맷.
const { findEmptyVars, kstStamp, won, maskPhone } = require("../notify");

describe("빈 변수 검사", () => {
  test("null · undefined · 공백뿐인 문자열을 잡는다", () => {
    expect(findEmptyVars({ a: null, b: undefined, c: "", d: "   ", e: "값" }).sort())
      .toEqual(["a", "b", "c", "d"]);
  });

  test("숫자 0 은 유효한 값이다", () => {
    // "보유 토큰 0개" 는 정상이라 발송을 막으면 안 된다.
    expect(findEmptyVars({ var1: 0, var2: "0개" })).toEqual([]);
  });

  test("빈 값이 없으면 빈 배열", () => {
    expect(findEmptyVars({ var1: "김승찬", var2: "가나고", var3: "고3" })).toEqual([]);
  });

  test("학교가 비어 있는 학생을 잡아낸다", () => {
    expect(findEmptyVars({ var1: "김승찬", var2: "", var3: "고3" })).toEqual(["var2"]);
  });
});

describe("포맷", () => {
  test("금액은 원화 표기", () => {
    expect(won(10000)).toBe("10,000원");
    expect(won(0)).toBe("0원");
    expect(won("25000")).toBe("25,000원");
  });

  test("일시는 한국 시각으로 찍는다", () => {
    // 2026-09-08T00:30:00Z → KST 09:30
    expect(kstStamp(Date.UTC(2026, 8, 8, 0, 30))).toBe("2026-09-08 09:30");
    // 자정을 넘겨 날짜가 바뀌는 경우
    expect(kstStamp(Date.UTC(2026, 8, 7, 16, 0))).toBe("2026-09-08 01:00");
  });

  test("로그에는 번호를 가려서 남긴다", () => {
    expect(maskPhone("010-1234-5678")).toBe("010****5678");
    expect(maskPhone("")).toBe("");
  });
});
