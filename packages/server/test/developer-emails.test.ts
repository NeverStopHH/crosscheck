/**
 * Alias emails (trial finding #7): developers have ONE crosscheck account but
 * commit under several git author emails, so every email — primary plus
 * admin-added aliases — must resolve to that one account. The invariant the
 * whole file circles is: AN EMAIL BELONGS TO AT MOST ONE DEVELOPER, whatever
 * table it entered through, and a cross-developer duplicate is a 409 the
 * caller can read (not a silent no-op that leaves absence matching wrong).
 */
import { describe, expect, test } from "bun:test";

import {
  TEST_ADMIN_TOKEN,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
} from "./helpers.ts";
import type { TestHarness } from "./helpers.ts";
import { MAX_EMAILS_PER_DEVELOPER } from "../src/services/developers.ts";

interface EmailView {
  readonly email: string;
  readonly isPrimary: boolean;
}

const listEmails = async (
  harness: TestHarness,
  developerId: string,
): Promise<{ status: number; emails: EmailView[] }> => {
  const response = await harness.app.request(
    `/api/developers/${encodeURIComponent(developerId)}/emails`,
    jsonRequest("GET", TEST_ADMIN_TOKEN),
  );
  if (response.status !== 200) {
    return { status: response.status, emails: [] };
  }
  const body = (await response.json()) as { data: { emails: EmailView[] } };
  return { status: response.status, emails: body.data.emails };
};

const addEmail = async (
  harness: TestHarness,
  developerId: string,
  email: string,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await harness.app.request(
    `/api/developers/${encodeURIComponent(developerId)}/emails`,
    jsonRequest("POST", TEST_ADMIN_TOKEN, { email }),
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
};

const removeEmail = async (
  harness: TestHarness,
  developerId: string,
  email: string,
): Promise<number> => {
  const response = await harness.app.request(
    `/api/developers/${encodeURIComponent(developerId)}/emails/${encodeURIComponent(email)}`,
    jsonRequest("DELETE", TEST_ADMIN_TOKEN),
  );
  return response.status;
};

describe("developer alias emails (admin)", () => {
  test("creating a developer records their email as the primary", async () => {
    // Arrange + Act
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "Nick@Example.com");

    // Assert: stored lowercased, flagged primary
    const { status, emails } = await listEmails(harness, nick.developerId);
    expect(status).toBe(200);
    expect(emails).toEqual([{ email: "nick@example.com", isPrimary: true }]);
  });

  test("an added alias is case-normalized and listed after the primary", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");

    // Act
    const added = await addEmail(harness, nick.developerId, "Nick.Personal@GMail.com");

    // Assert
    expect(added.status).toBe(200);
    const { emails } = await listEmails(harness, nick.developerId);
    expect(emails).toEqual([
      { email: "nick@example.com", isPrimary: true },
      { email: "nick.personal@gmail.com", isPrimary: false },
    ]);
  });

  test("re-adding an email the same developer already has is an idempotent 200", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await addEmail(harness, nick.developerId, "nick.personal@gmail.com");

    // Act
    const again = await addEmail(harness, nick.developerId, "NICK.PERSONAL@gmail.com");

    // Assert
    expect(again.status).toBe(200);
    const data = again.body["data"] as { alreadyLinked: boolean };
    expect(data.alreadyLinked).toBe(true);
    const { emails } = await listEmails(harness, nick.developerId);
    expect(emails.length).toBe(2);
  });

  test("an alias belonging to ANOTHER developer is refused with 409", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    const robin = await createTestDeveloper(harness, "Robin", "robin@example.com");
    await addEmail(harness, robin.developerId, "shared@example.com");

    // Act: Nick claims Robin's alias
    const conflict = await addEmail(harness, nick.developerId, "Shared@Example.com");

    // Assert: pinned — at most one developer per email
    expect(conflict.status).toBe(409);
    const { emails } = await listEmails(harness, nick.developerId);
    expect(emails).toEqual([{ email: "nick@example.com", isPrimary: true }]);
  });

  test("another developer's PRIMARY email is refused with 409 too", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await createTestDeveloper(harness, "Robin", "robin@example.com");

    // Act
    const conflict = await addEmail(harness, nick.developerId, "robin@example.com");

    // Assert
    expect(conflict.status).toBe(409);
  });

  test("creating a developer under an email already linked as an alias is refused", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await addEmail(harness, nick.developerId, "second@example.com");

    // Act: a new account under Nick's alias
    const response = await harness.app.request(
      "/api/developers",
      jsonRequest("POST", TEST_ADMIN_TOKEN, {
        name: "Imposter",
        email: "Second@Example.com",
      }),
    );

    // Assert: refused, and no half-created account remains behind
    expect(response.status).toBe(409);
    const again = await harness.app.request(
      "/api/developers",
      jsonRequest("POST", TEST_ADMIN_TOKEN, {
        name: "Fresh",
        email: "fresh@example.com",
      }),
    );
    expect(again.status).toBe(200);
  });

  test("the per-developer cap refuses the email past MAX_EMAILS_PER_DEVELOPER", async () => {
    // Arrange: fill the list — primary plus aliases up to the cap
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    for (let index = 1; index < MAX_EMAILS_PER_DEVELOPER; index += 1) {
      const added = await addEmail(
        harness,
        nick.developerId,
        `alias${String(index)}@example.com`,
      );
      expect(added.status).toBe(200);
    }

    // Act: one past the cap
    const overflow = await addEmail(
      harness,
      nick.developerId,
      "one-too-many@example.com",
    );

    // Assert: refused with the DISTINCT code, list bounded at the cap —
    // and re-adding an email already on the full list stays idempotent 200
    // (the cap bounds NEW rows, not recognition of existing ones).
    expect(overflow.status).toBe(409);
    const error = overflow.body["error"] as { code: string };
    expect(error.code).toBe("email_limit_reached");
    const { emails } = await listEmails(harness, nick.developerId);
    expect(emails.length).toBe(MAX_EMAILS_PER_DEVELOPER);
    const reAdd = await addEmail(harness, nick.developerId, "alias1@example.com");
    expect(reAdd.status).toBe(200);
    expect((reAdd.body["data"] as { alreadyLinked: boolean }).alreadyLinked).toBe(true);
  });

  test("a body that is not an email is a 400, before any lookup", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");

    // Act + Assert: schema-refused shapes never reach the service
    expect((await addEmail(harness, nick.developerId, "not-an-email")).status).toBe(400);
    expect((await addEmail(harness, nick.developerId, "")).status).toBe(400);
    const { emails } = await listEmails(harness, nick.developerId);
    expect(emails).toEqual([{ email: "nick@example.com", isPrimary: true }]);
  });

  test("removing an alias works; removing the primary is refused", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await addEmail(harness, nick.developerId, "nick.personal@gmail.com");

    // Act + Assert: alias removal
    expect(await removeEmail(harness, nick.developerId, "Nick.Personal@GMAIL.com")).toBe(200);
    const afterAlias = await listEmails(harness, nick.developerId);
    expect(afterAlias.emails).toEqual([
      { email: "nick@example.com", isPrimary: true },
    ]);

    // Act + Assert: the primary is the account identity and stays
    expect(await removeEmail(harness, nick.developerId, "nick@example.com")).toBe(400);
    // Act + Assert: an email that was never linked is a 404
    expect(await removeEmail(harness, nick.developerId, "ghost@example.com")).toBe(404);
  });

  test("an unknown developer id is a 404, and a developer key is not an admin token", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");

    // Act + Assert: unknown developer
    const missing = await addEmail(harness, "dev_ghost", "x@example.com");
    expect(missing.status).toBe(404);

    // Act + Assert: developer credentials are refused on the admin surface
    const asDeveloper = await harness.app.request(
      `/api/developers/${encodeURIComponent(nick.developerId)}/emails`,
      jsonRequest("POST", nick.apiKey, { email: "x@example.com" }),
    );
    expect(asDeveloper.status).toBe(401);
  });

  test("GET /api/settings shows the developer their own emails", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick@example.com");
    await addEmail(harness, nick.developerId, "nick.personal@gmail.com");

    // Act
    const response = await harness.app.request(
      "/api/settings",
      jsonRequest("GET", nick.apiKey),
    );

    // Assert
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { emails: EmailView[] };
    };
    expect(body.data.emails).toEqual([
      { email: "nick@example.com", isPrimary: true },
      { email: "nick.personal@gmail.com", isPrimary: false },
    ]);
  });
});
