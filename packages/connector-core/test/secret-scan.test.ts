import { describe, expect, test } from "bun:test";

import { containsSecret } from "../src/index.ts";

describe("containsSecret", () => {
  test("detects one sample of every guarded pattern", () => {
    // Arrange
    const positives = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "xoxb-1234567890-abcdefghij",
      "sk-ant-api03-abcdefghijklmnop",
      "AIzaSyA1234567890abcdefghijklmnopqrstuvw",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP",
      "postgresql://svc:hunter2hunter2@db.internal:5432/app",
      "api_key: A1b2C3d4E5f6G7h8I9j0",
    ];

    // Act & Assert
    for (const sample of positives) {
      expect(containsSecret(sample)).toBe(true);
    }
  });

  test("leaves ordinary paths and stack traces alone", () => {
    // Arrange
    const negatives = [
      "src/auth/token.ts",
      "packages/api/src/modules/agents/openclaw-config.service.ts",
      "TypeError: cannot read property 'sub' of undefined",
      "at verifyToken (/app/src/auth/verify.ts:88:3)",
      "secret sauce",
      "",
    ];

    // Act & Assert
    for (const sample of negatives) {
      expect(containsSecret(sample)).toBe(false);
    }
  });
});
