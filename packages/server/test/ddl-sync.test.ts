import { describe, expect, test } from "bun:test";
import {
  MAX_CLAIM_BODY_LENGTH,
  MAX_QUESTION_BODY_LENGTH,
} from "@crosscheck/schema";

const BOOTSTRAP_SQL_URL = new URL("../src/db/bootstrap.sql", import.meta.url);
const CLAIMS_BODY_CHECK_PATTERN =
  /claims_body_length_check CHECK \(char_length\(body\) <= (\d+)\)/;
const QUESTIONS_BODY_CHECK_PATTERN =
  /questions_body_length_check\s+CHECK \(char_length\(body\) <= (\d+)\)/;

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
});