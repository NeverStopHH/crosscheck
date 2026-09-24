/**
 * GET /api/suspect — "who was in there, and what did they say they were
 * doing" (regression-guard Stage 1, Sentry's suspect-commits move).
 *
 * This is the surface that can hurt somebody, so every guard on it is pinned
 * here rather than described:
 *
 *   - THE FALSIFIER GATE. Nothing is named until the pin's check recipe has
 *     been run and recorded FAILING. A live pin answers with counts and a
 *     reason, never with a session.
 *   - LIFT, NOT RAW OVERLAP. The denominator is that developer's own touches
 *     in the window, so the busiest person is not the default suspect. On a
 *     team whose members commit at 980/341/240 per month, raw overlap x
 *     recency is an accusation generator.
 *   - SESSIONS, NEVER PEOPLE. The response carries session ids, declared
 *     intents and work-context titles — no developer name and no developer
 *     id. The reader takes one deliberate hop to reach a person.
 *   - THE READER'S OWN SESSIONS COUNT. Nick's own agent breaking Nick's own
 *     pin a week later is the case the feature exists for.
 *   - TWO LABELLED EVIDENCE SOURCES. `sed -i` and codemods produce no Edit
 *     event, so a tool-only ranking confidently names the session that used
 *     Edit while the codemod session leaves no trace.
 *   - A MUTE IS NOT SILENCE. A muted author's session is still listed and
 *     labelled "notices suppressed by your mute" — never as "unanswered".
 */
import { describe, expect, test } from "bun:test";

import { PIN_PRESENCE_TERMINAL } from "@crosscheck/schema";

import { SUSPECT_MAX_CANDIDATES } from "../src/constants.ts";
import {
  addTestDeveloperWithSession,
  createTestDeveloper,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  TEST_START_ISO,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;
const PINNED_A = "src/workbench/PlaybackControls.tsx";
const PINNED_B = "src/workbench/usePlayback.ts";

interface CandidateView {
  readonly sessionId: string;
  readonly agentKind: string;
  readonly branch: string;
  readonly workContextId: string;
  readonly workContextTitle: string;
  readonly intent: { summary?: string } | null;
  readonly overlap: number;
  readonly authorTouches: number;
  readonly lift: number;
  readonly sources: readonly string[];
  readonly readerMuted: boolean;
  readonly isSelf: boolean;
}

interface SuspectView {
  readonly outcome: string;
  readonly falsifier: { readonly kind: string; readonly at: string | null };
  readonly attribution: string;
  readonly scope: {
    readonly kind: string;
    readonly files: readonly string[];
    readonly missingFiles: readonly string[];
    readonly surface: string | null;
  };
  readonly totals: {
    readonly sessionsTouching: number;
    readonly sessionsScored: number;
    readonly windowDays: number;
  };
  readonly candidates: readonly CandidateView[];
}

const suspect = async (
  harness: TestHarness,
  apiKey: string,
  query: string,
): Promise<{ readonly status: number; readonly view: SuspectView }> => {
  const response = await harness.app.request(
    `/api/suspect?repo=${encodeURIComponent(REPO)}&${query}`,
    jsonRequest("GET", apiKey),
  );
  const body = (await response.json()) as { data?: SuspectView };
  return {
    status: response.status,
    view:
      body.data ??
      ({
        outcome: "missing",
        falsifier: { kind: "missing", at: null },
        attribution: "missing",
        scope: { kind: "missing", files: [], missingFiles: [], surface: null },
        totals: { sessionsTouching: -1, sessionsScored: -1, windowDays: -1 },
        candidates: [],
      } satisfies SuspectView),
  };
};

const pinBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "pin_playback",
  repo: REPO,
  surface: "Play button plays/pauses",
  files: [PINNED_A, PINNED_B],
  check: "open /workbench, press Play",
  presence: PIN_PRESENCE_TERMINAL,
  verifiedAtCommit: "abc1234",
  ...overrides,
});

/** Seeds one work context with its file touches, and refuses on a rejection. */
const seedTouches = async (
  harness: TestHarness,
  developer: TestDeveloper,
  input: {
    readonly sessionId: string;
    readonly contextId: string;
    readonly title: string;
    readonly files: readonly string[];
    readonly intent?: Record<string, unknown>;
    readonly source?: string;
  },
): Promise<void> => {
  const records = [
    recordEnvelope(
      "work_context",
      validWorkContextBody({
        id: input.contextId,
        sessionId: input.sessionId,
        title: input.title,
        description: undefined,
        createdAt: TEST_START_ISO,
        ...(input.intent === undefined ? {} : { intent: input.intent }),
      }),
      { sessionId: input.sessionId },
    ),
    ...input.files.map((value) =>
      recordEnvelope(
        "target",
        {
          workContextId: input.contextId,
          kind: "file",
          value,
          ...(input.source === undefined ? {} : { source: input.source }),
        },
        { sessionId: input.sessionId },
      ),
    ),
  ];
  const result = await postRecords(harness, developer, { records });
  expect(result.status, `seeding ${input.contextId}`).toBe(200);
  expect(result.data?.rejected ?? 0, `seeding ${input.contextId}`).toBe(0);
};

const createPin = async (
  harness: TestHarness,
  apiKey: string,
  body: Record<string, unknown> = pinBody(),
): Promise<void> => {
  const response = await harness.app.request(
    "/api/pins",
    jsonRequest("POST", apiKey, body),
  );
  expect(response.status).toBe(200);
};

const breakPin = async (
  harness: TestHarness,
  apiKey: string,
  id = "pin_playback",
): Promise<void> => {
  const response = await harness.app.request(
    `/api/pins/${id}/broke`,
    jsonRequest("POST", apiKey, { repo: REPO, presence: PIN_PRESENCE_TERMINAL }),
  );
  expect(response.status).toBe(200);
};

describe("the falsifier gate", () => {
  test("names no session until the pin's check was run and failed", async () => {
    // Arrange: a live pin and a session that really did touch both its files.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-gate@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    await createPin(harness, nick.apiKey);
    await seedTouches(harness, nick, {
      sessionId: "ses_nick",
      contextId: "wc_nick",
      title: "Workbench filters",
      files: [PINNED_A, PINNED_B],
    });

    // Act
    const before = await suspect(harness, nick.apiKey, "pin=pin_playback");

    // Assert: counts, yes. Names, no.
    expect(before.status).toBe(200);
    expect(before.view.outcome).toBe("withheld");
    expect(before.view.falsifier.kind).toBe("not_recorded_broken");
    expect(before.view.candidates).toHaveLength(0);
    expect(before.view.totals.sessionsTouching).toBe(1);

    // Act: the human ran the recipe and it failed.
    await breakPin(harness, nick.apiKey);
    const after = await suspect(harness, nick.apiKey, "pin=pin_playback");

    // Assert
    expect(after.view.outcome).toBe("ranked");
    expect(after.view.falsifier.kind).toBe("recorded_break");
    expect(after.view.falsifier.at).not.toBeNull();
    expect(after.view.candidates).toHaveLength(1);
  });

  test("a pin with no check recipe can never unlock a name", async () => {
    // Arrange: a briefing-only pin (over the speaking cap) may omit the
    // recipe — and then there is nothing anybody could have run and failed.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-norecipe@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    const briefingOnly = pinBody({
      id: "pin_area",
      files: [
        PINNED_A,
        PINNED_B,
        "src/workbench/a.ts",
        "src/workbench/b.ts",
        "src/workbench/c.ts",
        "src/workbench/d.ts",
      ],
    });
    delete briefingOnly["check"];
    await createPin(harness, nick.apiKey, briefingOnly);
    await seedTouches(harness, nick, {
      sessionId: "ses_nick",
      contextId: "wc_nick",
      title: "Workbench filters",
      files: [PINNED_A],
    });
    await breakPin(harness, nick.apiKey, "pin_area");

    // Act
    const view = (await suspect(harness, nick.apiKey, "pin=pin_area")).view;

    // Assert
    expect(view.outcome).toBe("withheld");
    expect(view.falsifier.kind).toBe("no_check_recipe");
    expect(view.candidates).toHaveLength(0);
  });

  test("named files carry no pin, so the reader IS the falsifier — and it says so", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-files@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    await seedTouches(harness, nick, {
      sessionId: "ses_nick",
      contextId: "wc_nick",
      title: "Workbench filters",
      files: [PINNED_A],
    });

    // Act
    const view = (
      await suspect(harness, nick.apiKey, `path=${encodeURIComponent(PINNED_A)}`)
    ).view;

    // Assert
    expect(view.scope.kind).toBe("paths");
    expect(view.falsifier.kind).toBe("reader_named_files");
    expect(view.outcome).toBe("ranked");
    expect(view.candidates).toHaveLength(1);
  });
});

describe("ranking", () => {
  test("ranks by lift, so the busiest teammate is not the default suspect", async () => {
    // Arrange: Mike touched 12 files this window, two of them pinned. Ken
    // touched three, two of them pinned. Raw overlap ties them; lift does not.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-lift@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    const mike = await addTestDeveloperWithSession(
      harness,
      "Mike",
      "mike-lift@example.com",
      { id: "ses_mike" },
    );
    const ken = await addTestDeveloperWithSession(
      harness,
      "Ken",
      "ken-lift@example.com",
      { id: "ses_ken" },
    );
    await createPin(harness, nick.apiKey);
    await breakPin(harness, nick.apiKey);
    await seedTouches(harness, mike, {
      sessionId: "ses_mike",
      contextId: "wc_mike",
      title: "Sweep the workbench imports",
      files: [
        PINNED_A,
        PINNED_B,
        ...Array.from({ length: 10 }, (_unused, i) => `src/other/f${String(i)}.ts`),
      ],
    });
    await seedTouches(harness, ken, {
      sessionId: "ses_ken",
      contextId: "wc_ken",
      title: "Playback stutter on Safari",
      files: [PINNED_A, PINNED_B, "src/workbench/other.ts"],
    });

    // Act
    const view = (await suspect(harness, nick.apiKey, "pin=pin_playback")).view;

    // Assert
    expect(view.outcome).toBe("ranked");
    expect(view.candidates[0]?.workContextId).toBe("wc_ken");
    expect(view.candidates[0]?.overlap).toBe(2);
    expect(view.candidates[0]?.authorTouches).toBe(3);
    expect(view.candidates[1]?.workContextId).toBe("wc_mike");
    expect(view.candidates[1]?.authorTouches).toBe(12);
    // Both scores are printed, so the reader can disagree with the ranking.
    expect(view.candidates[0]?.lift).toBeGreaterThan(
      view.candidates[1]?.lift ?? Number.POSITIVE_INFINITY,
    );
  });

  test("includes the reader's OWN sessions — your agent is a suspect too", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-self@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    await createPin(harness, nick.apiKey);
    await breakPin(harness, nick.apiKey);
    await seedTouches(harness, nick, {
      sessionId: "ses_nick",
      contextId: "wc_nick",
      title: "Workbench filters",
      files: [PINNED_A, PINNED_B],
      intent: {
        summary: "Widen the workbench filter row",
        provenance: "declared",
        confidence: 1,
        capturedAt: TEST_START_ISO,
      },
    });

    // Act
    const view = (await suspect(harness, nick.apiKey, "pin=pin_playback")).view;

    // Assert
    expect(view.candidates).toHaveLength(1);
    expect(view.candidates[0]?.isSelf).toBe(true);
    expect(view.candidates[0]?.intent?.summary).toBe(
      "Widen the workbench filter row",
    );
  });

  test("prints at most three candidates, and says how many touched in total", async () => {
    // Arrange: four sessions on the pinned files.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-three@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    await createPin(harness, nick.apiKey);
    await breakPin(harness, nick.apiKey);
    for (const [index, name] of ["Ada", "Bo", "Cy", "Di"].entries()) {
      const dev = await addTestDeveloperWithSession(
        harness,
        name,
        `${name.toLowerCase()}-three@example.com`,
        { id: `ses_${name}` },
      );
      await seedTouches(harness, dev, {
        sessionId: `ses_${name}`,
        contextId: `wc_${name}`,
        title: `${name} was here`,
        // Different denominators so the ranking separates.
        files: [
          PINNED_A,
          ...Array.from(
            { length: index },
            (_unused, i) => `src/n/${name}-${String(i)}.ts`,
          ),
        ],
      });
    }

    // Act
    const view = (await suspect(harness, nick.apiKey, "pin=pin_playback")).view;

    // Assert
    expect(view.candidates).toHaveLength(3);
    expect(view.totals.sessionsTouching).toBe(4);
  });

  test("says so when nothing touched the surface at all", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-none@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    await createPin(harness, nick.apiKey);
    await breakPin(harness, nick.apiKey);
    await seedTouches(harness, nick, {
      sessionId: "ses_nick",
      contextId: "wc_nick",
      title: "Something else entirely",
      files: ["src/marketing/hero.tsx"],
    });

    // Act
    const view = (await suspect(harness, nick.apiKey, "pin=pin_playback")).view;

    // Assert
    expect(view.outcome).toBe("no_touch");
    expect(view.candidates).toHaveLength(0);
  });

  test("keeps the highest-lift session when more contexts touch than the read bound", async () => {
    // Arrange: the case SUSPECT_MAX_CANDIDATES' own comment anticipates — a
    // pinned file a whole team swept. Mike runs one more sweep context than
    // the read bound, each touching BOTH pinned files (overlap 2) out of a
    // 53-file fortnight. Ken touched one pinned file out of four, so his
    // raw overlap is the LOWEST in the repo and his lift is the highest.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-bound@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    await createPin(harness, nick.apiKey);
    await breakPin(harness, nick.apiKey);
    const mike = await createTestDeveloper(harness, "Mike", "mike-bound@example.com");
    for (let index = 0; index <= SUSPECT_MAX_CANDIDATES; index += 1) {
      const sessionId = `ses_mike_${String(index)}`;
      await registerTestSession(harness, mike.apiKey, { id: sessionId });
      await seedTouches(harness, mike, {
        sessionId,
        contextId: `wc_mike_${String(index)}`,
        title: `Sweep ${String(index)}`,
        files: [PINNED_A, PINNED_B, `src/sweep/f${String(index)}.ts`],
      });
    }
    const ken = await addTestDeveloperWithSession(
      harness,
      "Ken",
      "ken-bound@example.com",
      { id: "ses_ken" },
    );
    await seedTouches(harness, ken, {
      sessionId: "ses_ken",
      contextId: "wc_ken",
      title: "Rework the playback transport",
      files: [PINNED_A, "src/ken/a.ts", "src/ken/b.ts", "src/ken/c.ts"],
    });

    // Act
    const view = (await suspect(harness, nick.apiKey, "pin=pin_playback")).view;

    // Assert: the bound may cut the LOWEST scores, never the highest. A
    // pre-filter on raw overlap discards Ken before any lift is computed,
    // which is the metric this module's own rule 2 forbids from deciding.
    expect(view.candidates[0]?.workContextId).toBe("wc_ken");
    expect(view.candidates[0]?.lift).toBeCloseTo(0.25, 5);
    expect(view.outcome).toBe("ranked");
  });

  test("counts every touching session, not the ones the bound had room for", async () => {
    // Arrange: one more sweep context than the read bound, plus Ken. Fifty
    // two contexts touched the surface; fifty of them are scored.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-count@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    await createPin(harness, nick.apiKey);
    await breakPin(harness, nick.apiKey);
    const mike = await createTestDeveloper(harness, "Mike", "mike-count@example.com");
    for (let index = 0; index <= SUSPECT_MAX_CANDIDATES; index += 1) {
      const sessionId = `ses_mike_${String(index)}`;
      await registerTestSession(harness, mike.apiKey, { id: sessionId });
      await seedTouches(harness, mike, {
        sessionId,
        contextId: `wc_mike_${String(index)}`,
        title: `Sweep ${String(index)}`,
        files: [PINNED_A, PINNED_B, `src/sweep/f${String(index)}.ts`],
      });
    }
    const ken = await addTestDeveloperWithSession(
      harness,
      "Ken",
      "ken-count@example.com",
      { id: "ses_ken" },
    );
    await seedTouches(harness, ken, {
      sessionId: "ses_ken",
      contextId: "wc_ken",
      title: "Rework the playback transport",
      files: [PINNED_A, "src/ken/a.ts"],
    });

    // Act
    const view = (await suspect(harness, nick.apiKey, "pin=pin_playback")).view;

    // Assert: a printed total taken from the truncated array under-reports
    // by exactly the number of rows the reader is never told about.
    expect(view.totals.sessionsTouching).toBe(SUSPECT_MAX_CANDIDATES + 2);
    expect(view.totals.sessionsScored).toBe(SUSPECT_MAX_CANDIDATES);
  });

  test("says NO SEPARATED SUSPECT when the top two score the same", async () => {
    // Arrange: two sessions, identical overlap and identical denominators.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-tie@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    await createPin(harness, nick.apiKey);
    await breakPin(harness, nick.apiKey);
    for (const name of ["Ada", "Bo"]) {
      const dev = await addTestDeveloperWithSession(
        harness,
        name,
        `${name.toLowerCase()}-tie@example.com`,
        { id: `ses_${name}` },
      );
      await seedTouches(harness, dev, {
        sessionId: `ses_${name}`,
        contextId: `wc_${name}`,
        title: `${name} was here`,
        files: [PINNED_A, PINNED_B],
      });
    }

    // Act
    const view = (await suspect(harness, nick.apiKey, "pin=pin_playback")).view;

    // Assert: the rows are still printed WITH their scores — the honesty is
    // in the label, not in hiding the data.
    expect(view.outcome).toBe("no_separation");
    expect(view.candidates).toHaveLength(2);
  });
});

describe("evidence and privacy", () => {
  test("labels the two evidence sources separately", async () => {
    // Arrange: one session's Edit-reported touch, one session's Stop-time
    // git diff (a codemod that used no Edit tool at all).
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-src@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    const mike = await addTestDeveloperWithSession(
      harness,
      "Mike",
      "mike-src@example.com",
      { id: "ses_mike" },
    );
    await createPin(harness, nick.apiKey);
    await breakPin(harness, nick.apiKey);
    await seedTouches(harness, nick, {
      sessionId: "ses_nick",
      contextId: "wc_nick",
      title: "Workbench filters",
      files: [PINNED_A],
    });
    await seedTouches(harness, mike, {
      sessionId: "ses_mike",
      contextId: "wc_mike",
      title: "Codemod the prop names",
      files: [PINNED_A, PINNED_B],
      source: "git_diff",
    });

    // Act
    const view = (await suspect(harness, nick.apiKey, "pin=pin_playback")).view;

    // Assert
    const mikeRow = view.candidates.find((row) => row.workContextId === "wc_mike");
    const nickRow = view.candidates.find((row) => row.workContextId === "wc_nick");
    expect(mikeRow?.sources).toEqual(["git_diff"]);
    expect(nickRow?.sources).toEqual(["tool_edit"]);
  });

  test("names sessions and intents, never a developer name or id", async () => {
    // Arrange
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-anon@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    const mike = await addTestDeveloperWithSession(
      harness,
      "Mike",
      "mike-anon@example.com",
      { id: "ses_mike" },
    );
    await createPin(harness, nick.apiKey);
    await breakPin(harness, nick.apiKey);
    await seedTouches(harness, mike, {
      sessionId: "ses_mike",
      contextId: "wc_mike",
      title: "TM roster wiring",
      files: [PINNED_A, PINNED_B],
    });

    // Act
    const response = await harness.app.request(
      `/api/suspect?repo=${encodeURIComponent(REPO)}&pin=pin_playback`,
      jsonRequest("GET", nick.apiKey),
    );
    const raw = await response.text();

    // Assert: the whole payload, not just the fields we happen to read.
    expect(raw).toContain("ses_mike");
    expect(raw).not.toContain("Mike");
    expect(raw).not.toContain(mike.developerId);
  });

  test("lists a muted author's session, labelled as mute-suppressed", async () => {
    // Arrange: blaming somebody for ignoring a notice they could never
    // receive is how a trial ends socially rather than technically.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-mute@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    const mike = await addTestDeveloperWithSession(
      harness,
      "Mike",
      "mike-mute@example.com",
      { id: "ses_mike" },
    );
    await createPin(harness, nick.apiKey);
    await breakPin(harness, nick.apiKey);
    await seedTouches(harness, mike, {
      sessionId: "ses_mike",
      contextId: "wc_mike",
      title: "TM roster wiring",
      files: [PINNED_A, PINNED_B],
    });
    const muted = await harness.app.request(
      "/api/settings/mutes",
      jsonRequest("POST", nick.apiKey, { developer: "Mike" }),
    );
    expect(muted.status).toBe(200);

    // Act
    const view = (await suspect(harness, nick.apiKey, "pin=pin_playback")).view;

    // Assert
    expect(view.candidates).toHaveLength(1);
    expect(view.candidates[0]?.readerMuted).toBe(true);
  });
});

describe("a pin whose paths git no longer has", () => {
  test("carries the paths the hub knows are gone", async () => {
    // Arrange: a target row can only ever be recorded against a path that
    // EXISTS, so intersecting on a path the sweep already marked missing can
    // only ever return zero — and "no session touched this surface" reports
    // that zero as a fact about the world rather than about the pin.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-gone@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    await createPin(harness, nick.apiKey);
    const swept = await harness.app.request(
      "/api/pins/sweep",
      jsonRequest("POST", nick.apiKey, {
        repo: REPO,
        updates: [{ pinId: "pin_playback", path: PINNED_A, newPath: null }],
      }),
    );
    expect(swept.status).toBe(200);
    await breakPin(harness, nick.apiKey);

    // Act
    const view = (await suspect(harness, nick.apiKey, "pin=pin_playback")).view;

    // Assert: both paths are still the scope, and the dead one is named as
    // dead rather than silently intersected against.
    expect(view.outcome).toBe("no_touch");
    expect([...view.scope.files].sort()).toEqual([PINNED_A, PINNED_B].sort());
    expect(view.scope.missingFiles).toEqual([PINNED_A]);
  });
});

describe("the verdict rides as a sibling field (04 §5)", () => {
  /** The whole envelope, not the SuspectView-typed helper above. */
  const answer = async (
    harness: TestHarness,
    apiKey: string,
    query: string,
  ): Promise<{
    readonly verdict: {
      readonly attribution: string;
      readonly basis: string;
      readonly protection: string;
      readonly falsifier: string;
      readonly candidates: readonly unknown[];
      readonly evidence: { readonly support: string };
    };
  }> => {
    const response = await harness.app.request(
      `/api/suspect?repo=${encodeURIComponent(REPO)}&${query}`,
      jsonRequest("GET", apiKey),
    );
    const body = (await response.json()) as {
      data: {
        verdict: {
          attribution: string;
          basis: string;
          protection: string;
          falsifier: string;
          candidates: unknown[];
          evidence: { support: string };
        };
      };
    };
    return body.data;
  };

  test("a pin nobody falsified names nobody, and says WHICH refusal", async () => {
    // Arrange — the falsifier gate. A pin whose check nobody has run and
    // watched fail protects a behaviour nobody says is broken.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-v@example.com");
    await createPin(harness, nick.apiKey);

    // Act
    const { verdict } = await answer(harness, nick.apiKey, "pin=pin_playback");

    // Assert
    expect(verdict.attribution).toBe("INDETERMINATE");
    expect(verdict.basis).toBe("falsifier_absent");
    expect(verdict.candidates).toEqual([]);
  });

  test("AT-5 over HTTP: a fresh hub has no coverage, so nobody is exonerated", async () => {
    // Arrange — the reader names paths on a hub where nothing has reported.
    // The shipped sentence would say "whatever broke it is not in
    // crosscheck's record"; the verdict says the record was not complete.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-at5@example.com");

    // Act
    const { verdict } = await answer(
      harness,
      nick.apiKey,
      "path=src/workbench/usePlayback.ts",
    );

    // Assert — INDETERMINATE naming the gap, never UNATTRIBUTED.
    expect(verdict.attribution).toBe("INDETERMINATE");
    expect(verdict.basis).toBe("coverage_gap");
  });

  test("nothing is protected where the reader named the paths", async () => {
    // Arrange — no pin, so no invariant, so nothing to protect and nothing to
    // waive. Legality rule (9) says so and the route must not violate it.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-np@example.com");

    // Act
    const { verdict } = await answer(
      harness,
      nick.apiKey,
      "path=src/workbench/usePlayback.ts",
    );

    // Assert
    expect(verdict.protection).toBe("unprotected");
    expect(verdict.falsifier).toBe("reader_named_files");
  });

  test("the evidence axes are the weakest rung, and that is honest", async () => {
    // Arrange — a surface has no CLAIM, so there is no verification ref to
    // resolve. Mapping the pin's check recipe onto `tool_observed` would
    // invent a third ref kind, which 08 §8.5 declines in the same words it
    // uses for profiler traces: a recipe is an instruction to a human, not a
    // machine-produced observation.
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-ev@example.com");
    await createPin(harness, nick.apiKey);

    // Act
    const { verdict } = await answer(harness, nick.apiKey, "pin=pin_playback");

    // Assert
    expect(verdict.evidence.support).toBe("unsupported");
  });
});

/**
 * A PIN AND A TOUCH MEET HOWEVER EITHER WAS SPELLED (1.0 spec 01a §3.3d).
 *
 * The intersection is an exact-string join. Before one canonical form was
 * applied at every door, a pin typed as `./src/x.ts` against a touch of
 * `src/x.ts` intersected to nothing, and the answer read "no session touched
 * this surface" — an exoneration produced by a spelling, the direction nobody
 * reports. Each case here was measured failing that way before the fix.
 */
describe("a pin and a touch meet however either was spelled", () => {
  const rankedAfterBreak = async (
    pinFiles: readonly string[],
    touchedFiles: readonly string[],
  ): Promise<SuspectView> => {
    const harness = await createTestHarness();
    const nick = await createTestDeveloper(harness, "Nick", "nick-spell@example.com");
    await registerTestSession(harness, nick.apiKey, { id: "ses_nick" });
    await createPin(harness, nick.apiKey, pinBody({ files: [...pinFiles] }));
    await seedTouches(harness, nick, {
      sessionId: "ses_nick",
      contextId: "wc_nick",
      title: "Workbench filters",
      files: touchedFiles,
    });
    await breakPin(harness, nick.apiKey);
    return (await suspect(harness, nick.apiKey, "pin=pin_playback")).view;
  };

  test("a pin typed with ./ still finds the session that touched the file", async () => {
    // Arrange & Act
    const view = await rankedAfterBreak([`./${PINNED_A}`, `${PINNED_B}/`], [PINNED_A, PINNED_B]);

    // Assert
    expect(view.scope.files).toEqual([PINNED_A, PINNED_B]);
    expect(view.totals.sessionsTouching).toBe(1);
    expect(view.candidates.map((row) => row.sessionId)).toEqual(["ses_nick"]);
  });

  test("a touch a connector sent with ./ still meets the pin", async () => {
    // Arrange & Act — the hub canonicalises a file target at ingest, so a
    // connector that is not ours cannot spell its way out of the answer
    const view = await rankedAfterBreak([PINNED_A, PINNED_B], [`./${PINNED_A}`, `src//workbench/usePlayback.ts`]);

    // Assert
    expect(view.totals.sessionsTouching).toBe(1);
    expect(view.candidates.map((row) => row.sessionId)).toEqual(["ses_nick"]);
  });

  test("a decomposed file name meets its composed pin", async () => {
    // Arrange — git stores `café` composed; a macOS filesystem can hand the
    // connector the decomposed spelling
    const composed = "src/workbench/café.ts";
    const decomposed = "src/workbench/café.ts";

    // Act
    const view = await rankedAfterBreak([composed, PINNED_B], [decomposed, PINNED_B]);

    // Assert
    expect(view.candidates.map((row) => row.sessionId)).toEqual(["ses_nick"]);
    expect(view.candidates[0]?.overlap).toBe(2);
  });
});
