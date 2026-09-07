"use strict";

// 에뮬레이터 없이 도는 순수 계산 테스트 (금액 산정).
const { packagePrice, normalizePackages } = require("../tokens");

describe("packagePrice", () => {
  test("할인이 없으면 정가 그대로", () => {
    expect(packagePrice({ tokens: 10 }, 1000)).toEqual({
      tokens: 10, list: 10000, discount: 0, amount: 10000,
    });
  });

  test("정률 할인", () => {
    expect(packagePrice({ tokens: 10, discountType: "percent", discountValue: 20 }, 1000))
      .toEqual({ tokens: 10, list: 10000, discount: 2000, amount: 8000 });
  });

  test("정액 할인", () => {
    expect(packagePrice({ tokens: 5, discountType: "amount", discountValue: 1500 }, 1000))
      .toEqual({ tokens: 5, list: 5000, discount: 1500, amount: 3500 });
  });

  test("할인이 정가보다 커도 0원 아래로 내려가지 않는다", () => {
    const r = packagePrice({ tokens: 1, discountType: "amount", discountValue: 99999 }, 1000);
    expect(r.amount).toBe(0);
    expect(r.discount).toBe(1000);
  });

  test("정률 100% 초과는 100% 로 자른다", () => {
    expect(packagePrice({ tokens: 2, discountType: "percent", discountValue: 250 }, 1000).amount).toBe(0);
  });

  test("원 단위 아래는 버린다", () => {
    // 3 × 1000 = 3000 의 33% = 990
    expect(packagePrice({ tokens: 3, discountType: "percent", discountValue: 33 }, 1000).discount).toBe(990);
  });
});

describe("normalizePackages", () => {
  test("order 순으로 정렬하고 금액을 채워 준다", () => {
    const out = normalizePackages(
      [
        { id: "b", tokens: 10, order: 2 },
        { id: "a", tokens: 5, order: 1, discountType: "percent", discountValue: 10 },
      ],
      1000
    );
    expect(out.map((p) => p.id)).toEqual(["a", "b"]);
    expect(out[0].amount).toBe(4500);
    expect(out[1].amount).toBe(10000);
  });

  test("active 는 명시적으로 false 일 때만 비활성", () => {
    const out = normalizePackages([{ id: "x", tokens: 1 }, { id: "y", tokens: 1, active: false }], 100);
    expect(out.find((p) => p.id === "x").active).toBe(true);
    expect(out.find((p) => p.id === "y").active).toBe(false);
  });

  test("알 수 없는 할인 타입은 none 으로 떨어진다", () => {
    expect(normalizePackages([{ id: "z", tokens: 1, discountType: "weird" }], 100)[0].discountType).toBe("none");
  });
});
