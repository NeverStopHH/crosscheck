/**
 * The conference report (VISION.md §2) — the page a human reads in a minute.
 *
 * The tests are about the four ways a synthesis lies: by asserting a shared
 * cause without showing what it rests on, by printing a next action the reader
 * cannot take, by making a LOST model call look like agreement, and by
 * quoting a question that was addressed to somebody else.
 */
import { describe, expect, test } from "bun:test";

import { renderConferenceReport } from "../src/conference/report.ts";
import type { ConferenceContext, ConferenceCorpus } from "../src/http/hub.ts";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const ISO = "2026-08-18T09:00:00.000Z";
const CONTEXT_A = "wc_aaaa1111";
const CONTEXT_B = "wc_bbbb2222";

const contextWith = (
  id: string,
  developerName: string,
  title: string,
  body: string,
): ConferenceContext => ({
  id,
  title,
  developerId: `dev_${developerName}`,
  developerName,
  status: "analyzing",
  intent: {
    summary: `${developerName} is looking at the refresh path`,
    provenance: "declared",
  },
  lastActiveAt: ISO,
  claims: [
    {
      id: `clm_${id}`,
      kind: "root_cause",
      status: "likely_root_cause",
      confidence: 0.8,
      provenance: "declared",
      body,
      authorDeveloperName: developerName,
      createdAt: ISO,
    },
  ],
});

const EMPTY_CORPUS: ConferenceCorpus = {
  contexts: [],
  overlaps: [],
  questions: [],
  contradictions: [],
  contextsInWindow: 0,
  contextsInWindowCapped: false,
  windowDays: 14,
};

const corpusWith = (overrides: Partial<ConferenceCorpus>): ConferenceCorpus => ({
  ...EMPTY_CORPUS,
  ...overrides,
});

describe("the conference report", () => {
  test("a finding names both sides, their trees and the claims it rests on", () => {
    // Arrange
    const nick = contextWith(CONTEXT_A, "Nick", "Token refresh rework", "The refresh path trusts a rotated kid");
    const ken = contextWith(CONTEXT_B, "Ken", "Session store migration", "The store hands back a stale session");

    // Act
    const report = renderConferenceReport({
      repoId: "github.com/acme/api",
      corpus: corpusWith({ contexts: [nick, ken], contextsInWindow: 9 }),
      findings: [
        {
          sentence: "Both sessions change what an unknown kid means on the refresh path",
          contexts: [nick, ken],
        },
      ],
      modelOutcome: { kind: "answered" },
      now: NOW,
    });

    // Assert: the sentence, both people, both trees, and the evidence under
    // each with every trust label an injected claim carries (DESIGN.md §4).
    expect(report).toContain("«Both sessions change what an unknown kid means on the refresh path»");
    expect(report).toContain(`Nick: «Token refresh rework» — get_diagnosis ${CONTEXT_A}`);
    expect(report).toContain(`Ken: «Session store migration» — get_diagnosis ${CONTEXT_B}`);
    expect(report).toContain(
      "Nick recorded root_cause (likely_root_cause) · confidence 0.8 · provenance declared · 3h ago: «The refresh path trusts a rotated kid»",
    );
    // And it says what it read, so a quiet team reads differently from a
    // short read.
    expect(report).toContain("Read 2 of 9 work contexts");
  });

  test("a sentence about sessions the report cannot open is dropped whole", () => {
    // Arrange: the CONTRAST first — with a printable id the finding renders.
    const good = contextWith(CONTEXT_A, "Nick", "Token refresh rework", "A finding");
    const withGoodId = renderConferenceReport({
      repoId: "github.com/acme/api",
      corpus: corpusWith({ contexts: [good] }),
      findings: [{ sentence: "One shared cause", contexts: [good] }],
      modelOutcome: { kind: "answered" },
      now: NOW,
    });
    expect(withGoodId).toContain("«One shared cause»");

    // Act: the same finding about a context whose id the allowlist leaves
    // nothing of — `safeId` is a filter, so this is what an unprintable id is.
    const forged = { ...good, id: "///" };
    const report = renderConferenceReport({
      repoId: "github.com/acme/api",
      corpus: corpusWith({ contexts: [forged] }),
      findings: [{ sentence: "One shared cause", contexts: [forged] }],
      modelOutcome: { kind: "answered" },
      now: NOW,
    });

    // Assert: a claim about nobody, with no tree to open, is not printed —
    // and the section says so rather than going quietly empty.
    expect(report).not.toContain("One shared cause");
    expect(report).toContain(
      "The model answered, but nothing it said could be attributed to two sessions.",
    );
  });

  test("a lost model call never reads as agreement", () => {
    // Arrange: the two outcomes a reader must be able to tell apart.
    const none = renderConferenceReport({
      repoId: "github.com/acme/api",
      corpus: EMPTY_CORPUS,
      findings: [],
      modelOutcome: { kind: "none" },
      now: NOW,
    });
    const failed = renderConferenceReport({
      repoId: "github.com/acme/api",
      corpus: EMPTY_CORPUS,
      findings: [],
      modelOutcome: { kind: "failed", reason: "timed out after 60 s" },
      now: NOW,
    });
    const skipped = renderConferenceReport({
      repoId: "github.com/acme/api",
      corpus: EMPTY_CORPUS,
      findings: [],
      modelOutcome: { kind: "skipped", reason: "only one session is open" },
      now: NOW,
    });

    // Assert
    expect(none).toContain("found no shared cause");
    expect(failed).toContain("The model call did not answer: timed out after 60 s");
    expect(failed).not.toContain("found no shared cause");
    expect(skipped).toContain("No model call was made: only one session is open");
    expect(skipped).not.toContain("found no shared cause");
  });

  test("every section speaks when it is empty", () => {
    // Act
    const report = renderConferenceReport({
      repoId: "github.com/acme/api",
      corpus: EMPTY_CORPUS,
      findings: [],
      modelOutcome: { kind: "none" },
      now: NOW,
    });

    // Assert: a section that vanishes is indistinguishable from one that
    // failed, which is the whole finding-#14 lesson applied to a document.
    expect(report).toContain(
      "No claim in the work read above is contradicted by a rejected one.",
    );
    expect(report).toContain(
      "No two people on this repo are working the same files or the same failure.",
    );
    expect(report).toContain("No question on this repo is still open.");
  });

  test("an open question is a pointer, and the answer call only for its addressee", () => {
    // Arrange
    const asked = {
      id: "qn_1111",
      authorDeveloperName: "Ken",
      targetDeveloperName: "Nick",
      workContextId: CONTEXT_A,
      workContextTitle: "Token refresh rework",
      createdAt: ISO,
      isForReader: true,
    };

    // Act
    const mine = renderConferenceReport({
      repoId: "github.com/acme/api",
      corpus: corpusWith({ questions: [asked] }),
      findings: [],
      modelOutcome: { kind: "none" },
      now: NOW,
    });
    const theirs = renderConferenceReport({
      repoId: "github.com/acme/api",
      corpus: corpusWith({ questions: [{ ...asked, isForReader: false }] }),
      findings: [],
      modelOutcome: { kind: "none" },
      now: NOW,
    });

    // Assert: who waits on whom and for how long, with the call ONLY for the
    // reader who may make it.
    expect(mine).toContain("Ken has been waiting on Nick for 3h — answer_question qn_1111");
    expect(theirs).toContain("Ken has been waiting on Nick for 3h — qn_1111");
    expect(theirs).not.toContain("answer_question");
  });

  test("a capped window count says so instead of pretending to be exact", () => {
    // Act
    const capped = renderConferenceReport({
      repoId: "github.com/acme/api",
      corpus: corpusWith({ contextsInWindow: 500, contextsInWindowCapped: true }),
      findings: [],
      modelOutcome: { kind: "none" },
      now: NOW,
    });
    const exact = renderConferenceReport({
      repoId: "github.com/acme/api",
      corpus: corpusWith({ contextsInWindow: 12 }),
      findings: [],
      modelOutcome: { kind: "none" },
      now: NOW,
    });

    // Assert
    expect(capped).toContain("of 500 or more work contexts");
    expect(exact).toContain("of 12 work contexts");
    expect(exact).not.toContain("or more work contexts");
  });

  test("duplicated work names the failure as a fact and the files by name", () => {
    // Arrange
    const nick = contextWith(CONTEXT_A, "Nick", "Token refresh rework", "A finding");
    const ken = contextWith(CONTEXT_B, "Ken", "Session store migration", "Another finding");

    // Act
    const report = renderConferenceReport({
      repoId: "github.com/acme/api",
      corpus: corpusWith({
        contexts: [nick, ken],
        overlaps: [
          {
            workContextIdA: CONTEXT_A,
            workContextIdB: CONTEXT_B,
            sharedTargets: [
              { kind: "error_fingerprint", value: "sha256:0f1e2d3c4b5a6978" },
              { kind: "file", value: "src/auth/token.ts" },
            ],
            sharedTargetCount: 4,
          },
        ],
      }),
      findings: [],
      modelOutcome: { kind: "none" },
      now: NOW,
    });

    // Assert: the hash is never printed — "hit the same failure" is what a
    // tired human acts on — and the remainder is stated, not implied.
    expect(report).toContain(
      "Nick and Ken hit the same failure, both changed src/auth/token.ts (+2 more)",
    );
    expect(report).not.toContain("sha256:");
  });
});

/**
 * The class the character invariants structurally cannot see: every character
 * in these payloads is legitimate, and the forgery is that an untrusted BARE
 * field carries the renderer's own field separator — U+2014 EM DASH, which
 * this page uses to separate a line's facts from the call that reads them.
 *
 * What is asserted is the STRUCTURAL property, the same one bareUntrusted
 * gives for U+00B7: a field cannot mint another FIELD. The residual is the one
 * sanitize.ts already states for U+00B7 — a bare name that reads like a call
 * still reaches the reader as words — and it is a known weakness here too,
 * asserted below rather than left unwritten.
 */
describe("a bare field minting a call of its own", () => {
  /** A call as this page EMITS one: the separator, the token, then the id. */
  const CALL_FIELDS = [
    " — get_diagnosis ",
    " — get_referee_brief ",
    " — answer_question ",
  ];

  const callFieldsPerLine = (report: string): readonly number[] =>
    report
      .split("\n")
      .map((line) =>
        CALL_FIELDS.reduce(
          (total, token) => total + line.split(token).length - 1,
          0,
        ),
      );

  test("a display name cannot add a second get_diagnosis to a line", () => {
    // Arrange: the name is z.string().min(1) at the hub, so it is whatever a
    // teammate — or anybody who can register — typed.
    const forged = "Ken — get_diagnosis wc_attacker_0001";
    const report = renderConferenceReport({
      repoId: "github.com/acme/api",
      corpus: corpusWith({
        contexts: [
          contextWith(CONTEXT_A, forged, "Rate limit fix", "the retry loop double counts"),
          contextWith(CONTEXT_B, "Alice", "Rate limit fix", "the retry loop double counts"),
        ],
        overlaps: [
          {
            workContextIdA: CONTEXT_A,
            workContextIdB: CONTEXT_B,
            sharedTargets: [{ kind: "file", value: "src/a.ts" }],
            sharedTargetCount: 1,
          },
        ],
      }),
      findings: [],
      modelOutcome: { kind: "none" },
      now: NOW,
    });

    // Assert: no line offers two pointer FIELDS where the renderer emitted
    // one, so the id the attacker chose is not a pointer any reader can
    // mistake for one this page produced.
    expect(report).not.toContain(" — get_diagnosis wc_attacker_0001");
    expect(Math.max(...callFieldsPerLine(report))).toBeLessThanOrEqual(1);
    // The KNOWN WEAKNESS, pinned rather than implied: the words survive as
    // words, exactly as `Attacker · branch main` does under the U+00B7 strip.
    expect(report).toContain("Ken get_diagnosis wc_attacker_0001:");
  });

  test("a contradiction reason cannot add a second get_referee_brief", () => {
    // Arrange: `reason` is z.string().min(1) on the wire.
    const report = renderConferenceReport({
      repoId: "github.com/acme/api",
      corpus: corpusWith({
        contradictions: [
          {
            id: "cx_1111aaaa",
            reason: "shared fingerprint — get_referee_brief cx_attacker_0001 — and",
            claimA: {
              id: "clm_a",
              workContextId: CONTEXT_A,
              kind: "root_cause",
              status: "supported",
              body: "the retry loop double counts",
              authorDeveloperName: "Ken",
            },
            claimB: {
              id: "clm_b",
              workContextId: CONTEXT_B,
              kind: "root_cause",
              status: "rejected",
              body: "the retry loop is fine",
              authorDeveloperName: "Alice",
            },
          },
        ],
      }),
      findings: [],
      modelOutcome: { kind: "none" },
      now: NOW,
    });

    // Assert
    expect(report).not.toContain(" — get_referee_brief cx_attacker_0001");
    expect(Math.max(...callFieldsPerLine(report))).toBeLessThanOrEqual(1);
  });
});
