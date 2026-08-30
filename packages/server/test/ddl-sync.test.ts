import { describe, expect, test } from "bun:test";
import {
  MAX_CLAIM_BODY_LENGTH,
  MAX_PIN_CHECK_CHARS,
  MAX_PIN_SURFACE_CHARS,
  MAX_QUESTION_BODY_LENGTH,
} from "@crosscheck/schema";

const BOOTSTRAP_SQL_URL = new URL("../src/db/bootstrap.sql", import.meta.url);
const CLAIMS_BODY_CHECK_PATTERN =
  /claims_body_length_check CHECK \(char_length\(body\) <= (\d+)\)/;
const QUESTIONS_BODY_CHECK_PATTERN =
  /questions_body_length_check\s+CHECK \(char_length\(body\) <= (\d+)\)/;
const PINS_SURFACE_CHECK_PATTERN =
  /pins_surface_length_check CHECK \(char_length\(surface\) <= (\d+)\)/;
const PINS_CHECK_RECIPE_PATTERN =
  /pins_check_length_check\s+CHECK \(check_recipe IS NULL OR char_length\(check_recipe\) <= (\d+)\)/;

describe("bootstrap.sql DDL sync", () => {
  test("claims body CHECK matches MAX_CLAIM_BODY_LENGTH", async () => {
    // Arrange
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Act
    const match = bootstrapSql.match(CLAIMS_BODY_CHECK_PATTERN);

    // Assert
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(MAX_CLAIM_BODY_LENGTH);
  });

  test("questions body CHECK matches MAX_QUESTION_BODY_LENGTH", async () => {
    // Arrange: bootstrap.sql is the DDL a real-Postgres hub runs, and drizzle
    // is the migration authority — a cap that drifts between them lets one
    // deployment accept a body the other refuses.
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Act
    const match = bootstrapSql.match(QUESTIONS_BODY_CHECK_PATTERN);

    // Assert
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(MAX_QUESTION_BODY_LENGTH);
  });

  test("pins CHECKs match the pin caps in @crosscheck/schema", async () => {
    // Arrange: the pin registry is written by TWO DDL authorities — this file
    // on a real-Postgres hub and drizzle's schema.ts everywhere else — so a
    // cap that drifts between them lets one deployment store a surface label
    // the other refuses, and the refusal surfaces as a 500 on a person's
    // `crosscheck pin`.
    const bootstrapSql = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Act
    const surface = bootstrapSql.match(PINS_SURFACE_CHECK_PATTERN);
    const recipe = bootstrapSql.match(PINS_CHECK_RECIPE_PATTERN);

    // Assert
    expect(surface).not.toBeNull();
    expect(Number(surface?.[1])).toBe(MAX_PIN_SURFACE_CHARS);
    expect(recipe).not.toBeNull();
    expect(Number(recipe?.[1])).toBe(MAX_PIN_CHECK_CHARS);
  });
});
