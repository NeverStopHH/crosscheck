/**
 * WHAT A PROMPT ASKS THE HUB ABOUT (hold-out review round 5, C1): the one
 * rule the connector and the hub both call. A continuation scoped to its
 * clause: one that only leads leaves the rest to be asked about, one that
 * trails or is the whole prompt says nothing, and a rest that only reports a
 * status says nothing either.
 */
import { describe, expect, test } from "bun:test";

import { promptTaskOf } from "../src/prompt-task.ts";

const taskTextOf = (prompt: string): string | null => promptTaskOf(prompt)?.text ?? null;

describe("a continuation that only leads leaves the rest to be asked about", () => {
  test.each([
    ["next: add rate limiting to the upload endpoint", "add rate limiting to the upload endpoint"],
    ["weiter: jetzt bitte den CSV-Export bauen", "jetzt bitte den CSV-Export bauen"],
    ["ok cool, next: reverse charge VAT in checkout", "reverse charge VAT in checkout"],
    ["continue with something else: the dashboard is slow, check the widget queries", "the dashboard is slow, check the widget queries"],
    ["continue — but first the staging API is 500ing, missing env var", "but first the staging API is 500ing, missing env var"],
    ["mach weiter mit was anderem: Push-Notifications auf Android gehen nicht", "Push-Notifications auf Android gehen nicht"],
    ["ok next thing, SAML login for Okta", "SAML login for Okta"],
    ["go on. also, the M1 docker setup is broken for the new dev", "the M1 docker setup is broken for the new dev"],
  ])("%p asks about %p", (prompt, rest) => {
    // Arrange, Act
    const text = taskTextOf(prompt);

    // Assert
    expect(text).toBe(rest);
  });

  test.each([
    ["go ahead and then also add an audit log entry for role changes", "also add an audit log entry for role changes"],
    ["keep going, and then the HEIC thumbnails", "the HEIC thumbnails"],
    ["proceed, then write a README for the CLI", "write a README for the CLI"],
    ["jo passt, dann jetzt die Rechnungs-PDFs mit Umlauten", "jetzt die Rechnungs-PDFs mit Umlauten"],
    ["weiter so. Danach bitte die Websocket-Reconnects nach dem Deploy entschärfen", "bitte die Websocket-Reconnects nach dem Deploy entschärfen"],
    ["ok weiter und dann den refresh call nach der key rotation fixen", "den refresh call nach der key rotation fixen"],
  ])("a sequencing word opens a clause: %p asks about %p", (prompt, rest) => {
    expect(taskTextOf(prompt)).toBe(rest);
  });

  test("the rest is classified on its own: its terms, never the continuation's", () => {
    // Arrange, Act
    const task = promptTaskOf("next: add rate limiting to the upload endpoint");

    // Assert
    expect(task?.terms.hasContinuation).toBe(false);
    expect(task?.terms.ranked).not.toContain("next");
    expect(task?.terms.topical).toEqual(expect.arrayContaining(["upload", "endpoint"]));
  });
});

describe("a continuation that trails, or is the whole prompt, says nothing", () => {
  test.each([
    ["cool, cache fix is merged, next", "a report, then the hand-back"],
    ["die e2e tests laufen lokal, mach weiter", "a report, then the hand-back"],
    ["yes the SSO login works on staging now, carry on", "a report, then the hand-back"],
    ["fix the CSV export, then continue", "a sequencing word before the trailing continuation"],
    ["weiter: fix the CSV export, then continue", "the rest carries the session on again"],
    ["continue the orders partition migration", "one clause: the session's own work"],
    ["mach weiter mit dem CSV-Export", "one clause: the session's own work"],
    ["keep going on the SAML stuff", "one clause: the session's own work"],
    ["jetzt weiter mit dem Flag-Client statt LaunchDarkly", "one clause: the session's own work"],
    ["the limit was reset but StatsBomb still returns 429, continue debugging", "the activity carried on trails"],
    ["weiter", "nothing but the continuation"],
    ["ok, weiter, danke", "nothing but quiet clauses"],
  ])("%p — %s", (prompt) => {
    expect(promptTaskOf(prompt)).toBeNull();
  });
});

describe("a rest that only reports a status says nothing (the status-report guard)", () => {
  test.each([
    ["continue: the refresh token fix is deployed"],
    ["next, the database migration for the orders table is merged"],
    ["weiter, der Import-Worker läuft wieder"],
    ["go on — the OAuth refresh race fix works now"],
    ["mach weiter, der PDF-Export ist fertig"],
    ["keep going, the flaky integration tests are green again"],
    ["proceed, the checkout webhook is done"],
    ["weiter, das Chunked Upload klappt jetzt"],
    ["ok weiter, die Migration passt"],
    ["next: the cache fix is merged, thanks"],
  ])("%p", (prompt) => {
    expect(promptTaskOf(prompt)).toBeNull();
  });

  test.each([
    ["weiter, der Export klappt nicht mit Umlauten", "der Export klappt nicht mit Umlauten"],
    ["next: the webhook retry doesn't work on staging", "the webhook retry doesn't work on staging"],
    ["next: CI isn't green on main since the cache change", "CI isn't green on main since the cache change"],
    ["continue: the cache fix is merged, now the invalidation of product prices", "the cache fix is merged, now the invalidation of product prices"],
  ])("a negated or followed status is a task: %p asks about %p", (prompt, rest) => {
    expect(taskTextOf(prompt)).toBe(rest);
  });
});

describe("a signal word that names a thing carries nothing on (round 5, L1)", () => {
  test.each([
    ["continue button in checkout does nothing"],
    ["the proceed button is greyed out on mobile"],
    ["the preceding migration dropped the index"],
  ])("%p is asked about whole", (prompt) => {
    expect(taskTextOf(prompt)).toBe(prompt);
  });
});

describe("a prompt without a continuation is asked about whole, and a content-free one not at all", () => {
  test("a plain task", () => {
    expect(taskTextOf("token refresh fails after key rotation")).toBe("token refresh fails after key rotation");
  });

  test.each([["ok"], ["passt"], ["bun test"]])("%p asks about nothing", (prompt) => {
    expect(promptTaskOf(prompt)).toBeNull();
  });
});
