/**
 * THE RACE'S CUT (batch-2 integration review, H2), as a property of the
 * code: a claim a hook's output must deliver registers its undo with the
 * race, and a race the budget won runs every undo registered before it and
 * refuses every claim after it (config/hook-budget.ts hookRace). No process,
 * no file and no real clock: the cut is called, never waited for.
 */
import { describe, expect, test } from "bun:test";

import { hookRace } from "../src/config/hook-budget.ts";

const NOW_MS = 1_000_000;
const DEADLINE_MS = NOW_MS + 800;
const TIMEOUT_MS = 400;
const frozen = (): number => NOW_MS;

describe("a hook's race", () => {
  test("is not cut until its runner says so, and spares what hookBudget spares", () => {
    // Arrange
    const race = hookRace(DEADLINE_MS, TIMEOUT_MS, frozen);

    // Act
    const isCut = race.budget.isCut?.();

    // Assert
    expect(isCut).toBe(false);
    expect(race.budget.spareMs()).toBe(DEADLINE_MS - NOW_MS - TIMEOUT_MS);
  });

  test("a cut runs every undo registered before it, and from then on answers cut", async () => {
    // Arrange
    const race = hookRace(DEADLINE_MS, TIMEOUT_MS, frozen);
    const undone: string[] = [];
    race.budget.onCut?.(async () => {
      undone.push("ask");
    });
    race.budget.onCut?.(async () => {
      undone.push("tell");
    });

    // Act
    const ran = await race.cut();

    // Assert
    expect(ran).toBe(2);
    expect([...undone].sort()).toEqual(["ask", "tell"]);
    expect(race.budget.isCut?.()).toBe(true);
  });

  test("an undo that throws does not stop the others, and the cut never throws", async () => {
    // Arrange
    const race = hookRace(DEADLINE_MS, TIMEOUT_MS, frozen);
    const undone: string[] = [];
    race.budget.onCut?.(async () => {
      throw new Error("a busy lock");
    });
    race.budget.onCut?.(async () => {
      undone.push("tell");
    });

    // Act
    const ran = await race.cut();

    // Assert
    expect(ran).toBe(2);
    expect(undone).toEqual(["tell"]);
  });

  test("a race nobody cut runs no undo", async () => {
    // Arrange
    const race = hookRace(DEADLINE_MS, TIMEOUT_MS, frozen);
    const undone: string[] = [];

    // Act
    race.budget.onCut?.(async () => {
      undone.push("ask");
    });

    // Assert
    expect(undone).toEqual([]);
    expect(race.budget.isCut?.()).toBe(false);
  });
});
