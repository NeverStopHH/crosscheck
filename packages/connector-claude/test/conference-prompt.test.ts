/**
 * What the conference shows the model and what it accepts back (VISION.md §2).
 *
 * The two failures these guard are the ones that make a synthesis dangerous
 * rather than merely useless: a model that learns WHO wrote something can
 * invent a sentence about a named person, and an answer whose shape this
 * machine cannot read must never be recorded as the model agreeing that there
 * was nothing to find.
 */
import { describe, expect, test } from "bun:test";

import {
  CONFERENCE_MAX_INPUT_CHARS,
  CONFERENCE_SENTENCE_MAX_CHARS,
} from "@crosscheck/connector-core/constants.ts";
import type { ConferenceContext } from "@crosscheck/connector-core/http/hub.ts";
import { SUMMARIZER_LEAN_FLAGS } from "@crosscheck/connector-core/model/runner.ts";
import {
  CONFERENCE_PROMPT,
  estimateInputTokens,
  fitSessions,
  labelSessions,
  parseConferenceAnswer,
  renderConferenceInput,
  resolveConferenceArgv,
} from "../src/conference/prompt.ts";

const ISO = "2026-08-18T09:00:00.000Z";

const contextWith = (
  id: string,
  developerName: string,
  overrides: Partial<ConferenceContext> = {},
): ConferenceContext => ({
  id,
  title: `${developerName} title`,
  developerId: `dev_${developerName}`,
  developerName,
  status: "analyzing",
  intent: {
    summary: `${developerName.toLowerCase()} is rewriting the refresh path`,
    provenance: "declared",
  },
  lastActiveAt: ISO,
  claims: [
    {
      id: `clm_${id}`,
      kind: "observation",
      status: "proposed",
      confidence: 0.6,
      provenance: "declared",
      body: "Refresh returns 500 when the kid is unknown",
      authorDeveloperName: developerName,
      createdAt: ISO,
    },
  ],
  ...overrides,
});

describe("the conference input", () => {
  test("shows intents and declared findings under labels, and no person at all", () => {
    // Arrange
    const sessions = labelSessions([
      contextWith("wc_a", "Nick"),
      contextWith("wc_b", "Ken"),
    ]);

    // Act
    const input = renderConferenceInput(sessions);

    // Assert: the labels are what the answer will be attributed by, and the
    // model is never told whose work it is looking at.
    expect(input).toContain("SESSION A intends: nick is rewriting the refresh path");
    expect(input).toContain("SESSION B intends: ken is rewriting the refresh path");
    expect(input).toContain("- observation (proposed): Refresh returns 500 when the kid is unknown");
    expect(input).not.toContain("Nick");
    expect(input).not.toContain("Ken");
    expect(input).not.toContain("title");
  });

  test("a session with no plan and no findings says so rather than vanishing", () => {
    // Arrange
    const sessions = labelSessions([
      contextWith("wc_a", "Nick", { intent: null, claims: [] }),
    ]);

    // Act + Assert: a silently absent session would make the model compare
    // fewer plans than the report says it read.
    const input = renderConferenceInput(sessions);
    expect(input).toContain("SESSION A intends: (not stated)");
    expect(input).toContain("SESSION A has recorded no findings.");
  });

  test("a hostile hub cannot grow the prompt: whole sessions drop, never half a one", () => {
    // Arrange: the CONTRAST first — two ordinary sessions both fit.
    const ordinary = labelSessions([contextWith("wc_a", "A"), contextWith("wc_b", "B")]);
    expect(renderConferenceInput(ordinary)).toContain("SESSION B intends:");

    // Act: a hub that sends a megabyte of claim body.
    const huge = contextWith("wc_a", "A", {
      claims: [
        {
          id: "clm_huge",
          kind: "observation",
          status: "proposed",
          confidence: 0.6,
          provenance: "declared",
          body: "x".repeat(CONFERENCE_MAX_INPUT_CHARS * 2),
          authorDeveloperName: "A",
          createdAt: ISO,
        },
      ],
    });
    const input = renderConferenceInput(
      labelSessions([huge, contextWith("wc_b", "B")]),
    );

    // Assert: bounded, and what survives is a whole session.
    expect(input.length).toBeLessThanOrEqual(CONFERENCE_MAX_INPUT_CHARS);
    expect(estimateInputTokens(input) * 4).toBeLessThanOrEqual(
      CONFERENCE_MAX_INPUT_CHARS + 4,
    );
    for (const line of input.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(CONFERENCE_MAX_INPUT_CHARS);
    }
    // AND SOMETHING SURVIVED. Every assertion above is an upper bound, and an
    // empty string satisfies all of them — so without this line the test is
    // green on an input that dropped the whole team.
    expect(input).toContain("SESSION B intends:");
  });

  test("one session too big to send does not silence the ones behind it", () => {
    // Arrange: the shape the document bound exists for — a hub that is
    // modified or hostile, sending one context with far more claims than its
    // own cap allows. The per-field cut bounds each BODY, so only the number
    // of them can blow the document.
    const flood = contextWith("wc_a", "A", {
      claims: Array.from({ length: 200 }, (_, index) => ({
        id: `clm_${String(index)}`,
        kind: "observation",
        status: "proposed",
        confidence: 0.6,
        provenance: "declared",
        body: "y".repeat(290),
        authorDeveloperName: "A",
        createdAt: ISO,
      })),
    });

    // Act
    const sessions = labelSessions([flood, contextWith("wc_b", "B")]);
    const input = renderConferenceInput(sessions);

    // Assert: the one that cannot fit is dropped, and ONLY it. A hub that can
    // empty every teammate's conference by sending one fat context is a
    // denial of service with a 200 on it.
    expect(input).not.toContain("SESSION A intends:");
    expect(input).toContain("SESSION B intends:");
    expect(input.length).toBeLessThanOrEqual(CONFERENCE_MAX_INPUT_CHARS);
    // And the label that was not sent is not one the answer may use.
    expect(fitSessions(sessions).map((session) => session.label)).toEqual(["B"]);
  });
});

describe("the conference answer", () => {
  const labels = new Set(["A", "B", "C"]);

  test("NONE is an answer; an unreadable shape is not the same answer", () => {
    // Assert: the distinction the doctor line rests on.
    expect(parseConferenceAnswer("NONE", labels)).toEqual({ kind: "none" });
    expect(parseConferenceAnswer("none.", labels)).toEqual({ kind: "none" });
    expect(parseConferenceAnswer("", labels).kind).toBe("unreadable");
    expect(
      parseConferenceAnswer("I think sessions might be related somehow", labels).kind,
    ).toBe("unreadable");
  });

  test("a finding names two DIFFERENT sessions this run actually labelled", () => {
    // Arrange + Act
    const good = parseConferenceAnswer(
      "A+C: Both treat an unknown kid as fatal on the refresh path",
      labels,
    );

    // Assert
    expect(good).toEqual({
      kind: "findings",
      findings: [
        {
          labelA: "A",
          labelB: "C",
          sentence: "Both treat an unknown kid as fatal on the refresh path",
        },
      ],
    });

    // Assert: a label nobody was given, and one session named twice, are both
    // sentences about nobody — dropped, and with nothing left the answer is
    // unreadable rather than a NONE.
    expect(parseConferenceAnswer("A+Q: something", labels).kind).toBe("unreadable");
    expect(parseConferenceAnswer("A+A: something", labels).kind).toBe("unreadable");
  });

  test("one readable line among noise survives, bounded", () => {
    // Arrange: models add preambles; the parser reads lines, not documents.
    const answer = parseConferenceAnswer(
      [
        "Here is what I found:",
        `B+A: ${"y".repeat(CONFERENCE_SENTENCE_MAX_CHARS * 2)}`,
      ].join("\n"),
      labels,
    );

    // Assert
    expect(answer.kind).toBe("findings");
    const findings = answer.kind === "findings" ? answer.findings : [];
    expect(findings.length).toBe(1);
    expect(findings[0]?.sentence.length).toBeLessThanOrEqual(
      CONFERENCE_SENTENCE_MAX_CHARS,
    );
  });
});

describe("the conference argv", () => {
  test("is the summarizer's own lean run, and the override replaces it wholesale", () => {
    // Assert: the same binary, model and flags as every other model call this
    // product makes — one runner, one set of flags to keep verified.
    const argv = resolveConferenceArgv({});
    expect(argv[0]).toBe("claude");
    expect(argv).toContain(CONFERENCE_PROMPT);
    for (const flag of SUMMARIZER_LEAN_FLAGS) {
      expect(argv).toContain(flag);
    }
    expect(resolveConferenceArgv({ CROSSCHECK_SUMMARIZER_CMD: "/tmp/fake" })).toEqual([
      "/tmp/fake",
    ]);
  });

  test("the prompt names NONE as the usual answer", () => {
    // The one lever this design has on a model that will always find a
    // conflict if asked to (ghost/prompt.ts makes the same argument).
    expect(CONFERENCE_PROMPT).toContain("NONE is the usual answer");
    expect(CONFERENCE_PROMPT).toContain("never name a person");
  });
});
