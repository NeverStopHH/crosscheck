/**
 * The bounded pending-map (design §2.4): id → (method, params) per
 * direction, "the only protocol state the proxy keeps beyond per-session
 * capture state". Bounded by construction — a peer that never answers its
 * requests must cost a fixed amount of memory, so past the cap the OLDEST
 * entry is evicted (its eventual response then simply captures nothing,
 * which is the fail-open direction).
 */
import { describe, expect, test } from "bun:test";

import { ACP_MAX_PENDING_REQUESTS } from "../src/constants.ts";
import { createPendingMap } from "../src/capture/pending.ts";

describe("createPendingMap", () => {
  test("put then take returns the entry exactly once", () => {
    const map = createPendingMap();

    map.put(1, { method: "session/new", params: { cwd: "/r" } });

    expect(map.take(1)).toEqual({ method: "session/new", params: { cwd: "/r" } });
    expect(map.take(1)).toBeNull();
  });

  test("string and numeric ids never collide", () => {
    const map = createPendingMap();

    map.put(1, { method: "a", params: null });
    map.put("1", { method: "b", params: null });

    expect(map.take(1)?.method).toBe("a");
    expect(map.take("1")?.method).toBe("b");
  });

  test("past the cap the OLDEST entry is evicted and counted", () => {
    const map = createPendingMap(3);

    map.put(1, { method: "m1", params: null });
    map.put(2, { method: "m2", params: null });
    map.put(3, { method: "m3", params: null });
    map.put(4, { method: "m4", params: null });

    expect(map.take(1)).toBeNull();
    expect(map.take(4)?.method).toBe("m4");
    expect(map.evictions()).toBe(1);
    expect(map.size()).toBe(2);
  });

  test("the default cap is the named constant", () => {
    const map = createPendingMap();
    for (let index = 0; index < ACP_MAX_PENDING_REQUESTS + 10; index += 1) {
      map.put(index, { method: "m", params: null });
    }

    expect(map.size()).toBe(ACP_MAX_PENDING_REQUESTS);
    expect(map.evictions()).toBe(10);
  });
});
