/**
 * THE BOUNDARY, EXECUTABLE (review round 4, C). Each review of the opt-out
 * found another side channel, because shared work carries time. So instead
 * of naming the next leak, this test names what MAY differ: two worlds that
 * are the same opted-out world (test/opted-out-world.ts) but for ONE action
 * of Robin's, each walked as Nick over every route and variant of the table
 * (test/live-location-routes.ts), bodies AND headers. Every line that
 * differs must sit on the RESIDUALS list below, and every residual points at
 * the sentence of services/visibility.ts that accepts it. Anything else —
 * a new field, a new route, a new action — fails until somebody either
 * withholds it or writes down, there, why it may show.
 *
 * Two identical worlds are walked first: any difference between them is
 * noise the masks did not remove, and fails too, so a residual can never be
 * hiding behind noise.
 */
import { describe, expect, test } from "bun:test";
import { deliveryIdFor } from "@crosscheck/schema";

import {
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validWorkContextBody,
} from "./helpers.ts";
import { ROUTES } from "./live-location-routes.ts";
import { call, label, walk } from "./live-location-walk.ts";
import type { Answer } from "./live-location-walk.ts";
import {
  CREATED_AT,
  HOST_CREATED_AT,
  HOST_TITLE,
  NICK_CONTEXT,
  REPO,
  ROBIN_CONTEXT,
  ROBIN_HOST_CONTEXT,
  ROBIN_LIVE,
  SECRET_BRANCH,
  SECRET_SHA,
  instantsNear,
  leaksIn,
  seedOptedOutWorld,
} from "./opted-out-world.ts";
import type { OptedOutWorld } from "./opted-out-world.ts";

/** Her action lands this long after the seed; the walk reads this long after it. */
const ACTION_DELAY_S = 10;
const READ_DELAY_S = 70;
/** A session id of hers that exists in neither world before the action. */
const ROBIN_DIFF_SESSION = "cc_bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
/** A default-branch commit anybody's clone names: published, never hers. */
const MAIN_COMMIT = "0123abc4567def";

interface Action {
  readonly name: string;
  /** Shared work: may show what it says and when it was created, never her instants. */
  readonly content?: true;
  readonly run: (world: OptedOutWorld) => Promise<void>;
}

const nowIso = (world: OptedOutWorld): string => world.harness.clock.now().toISOString();
const MS_PER_HOUR = 3_600_000;
const hourBefore = (world: OptedOutWorld): string => new Date(world.harness.clock.now().getTime() - MS_PER_HOUR).toISOString();

const expectOk = async (response: Response, what: string): Promise<void> => {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${what} answered ${String(response.status)}: ${await response.text()}`);
  }
};

const records = async (world: OptedOutWorld, recordsToPost: readonly Record<string, unknown>[], what: string): Promise<void> => {
  const posted = await postRecords(world.harness, world.robin, { records: [...recordsToPost] });
  if (posted.status !== 200 || (posted.data?.rejected ?? 1) > 0) {
    throw new Error(`${what} was not accepted: ${JSON.stringify(posted.data?.results)}`);
  }
};

const post = async (world: OptedOutWorld, path: string, body: unknown, what: string): Promise<void> =>
  expectOk(await world.harness.app.request(path, jsonRequest("POST", world.robin.apiKey, body)), what);

const live = (kind: string, body: Record<string, unknown>): Record<string, unknown> =>
  recordEnvelope(kind, body, { sessionId: ROBIN_LIVE });

/**
 * HER ACTIONS: every kind of thing her agent does after the opt-out — the
 * reviewer's probe-diff.ts fifteen, and the round's start, stop, re-register,
 * set_intent and pin. PRESENCE actions should change nothing a colleague
 * reads but a residual; CONTENT actions are shared work, which may also show
 * what it says and when it was created — never an instant of hers.
 */
const ACTIONS: readonly Action[] = [
  {
    name: "start a session",
    run: async (w) => expectOk(await registerTestSession(w.harness, w.robin.apiKey, { id: ROBIN_DIFF_SESSION, branch: SECRET_BRANCH, baseCommit: SECRET_SHA }), "start"),
  },
  { name: "heartbeat", run: (w) => post(w, `/api/sessions/${ROBIN_LIVE}/heartbeat`, { status: "implementing" }, "heartbeat") },
  { name: "heartbeat with a new status", run: (w) => post(w, `/api/sessions/${ROBIN_LIVE}/heartbeat`, { status: "testing" }, "status") },
  { name: "end the live session", run: (w) => post(w, `/api/sessions/${ROBIN_LIVE}/end`, { status: "done" }, "end") },
  {
    name: "re-register on another branch",
    run: async (w) => expectOk(await registerTestSession(w.harness, w.robin.apiKey, { id: ROBIN_LIVE, branch: "feat/robin-moves-again", baseCommit: SECRET_SHA }), "re-register"),
  },
  {
    name: "re-observe a claim",
    run: (w) => records(w, [live("claim", validClaimBody({ id: "clm_robin_diff_again", workContextId: ROBIN_CONTEXT, authorSessionId: ROBIN_LIVE, kind: "hypothesis", status: "rejected", body: "Rotation finished inside its window on every sampled failure", createdAt: nowIso(w) }))], "re-observation"),
  },
  {
    name: "report landed work",
    run: (w) => records(w, [live("landed_evidence", { repo: REPO, defaultBranch: "main", checkedAt: nowIso(w), commits: [SECRET_SHA] })], "landed"),
  },
  {
    // What git log said at her SessionStart: commits from an hour back —
    // published history — collected now, which is hers.
    name: "report commit evidence",
    run: (w) => records(w, [live("commit_evidence", { repo: REPO, collectedAt: nowIso(w), windowDays: 14, authors: [{ name: "Ken", email: "ken@example.com", latestCommitAt: hourBefore(w), commitCount: 1 }, { name: "Sam", email: "sam@example.com", latestCommitAt: hourBefore(w), commitCount: 4 }] })], "commit evidence"),
  },
  {
    name: "revalidate a teammate's claim",
    // Her pull found Nick's claim stale: a downgrade names the default-branch
    // commit that touched its files — published history.
    content: true,
    run: (w) => post(w, "/api/claim-revalidations", { repo: REPO, revalidated: 1, total: 1, entries: [{ claimId: "clm_nick", result: "changed", basis: "context_targets", refCommit: SECRET_SHA, touchingCommits: [MAIN_COMMIT], touchingTotal: 1 }] }, "revalidation"),
  },
  {
    name: "pull a hint and the diagnosis",
    run: async (w) => {
      await records(w, [live("hint_delivery", { id: deliveryIdFor(ROBIN_LIVE, NICK_CONTEXT, "prompt_hint"), sessionId: ROBIN_LIVE, refKind: "work_context", refId: NICK_CONTEXT, channel: "prompt_hint", deliveredAt: nowIso(w) })], "hint delivery");
      await expectOk(await w.harness.app.request(`/api/work-contexts/${NICK_CONTEXT}/diagnosis?session=${ROBIN_LIVE}`, { headers: { Authorization: `Bearer ${w.robin.apiKey}` } }), "pull");
    },
  },
  {
    // Every READ of the table as her — the writes are other actions.
    name: "read every route herself",
    run: async (w) => {
      for (const [key, spec] of Object.entries(ROUTES)) {
        if (!key.startsWith("GET ") || spec.notCalled !== undefined) {
          continue;
        }
        for (const variant of spec.variants.filter((each) => each.as !== "admin")) {
          await call(w, "robin", key, variant);
        }
      }
    },
  },
  {
    name: "resend an unchanged context",
    run: (w) => records(w, [live("work_context", validWorkContextBody({ id: ROBIN_CONTEXT, sessionId: ROBIN_LIVE, title: `${SECRET_BRANCH} @ api`, titleSource: "fallback", status: "implementing", createdAt: CREATED_AT }))], "resend"),
  },
  {
    name: "set an intent",
    content: true,
    run: (w) => records(w, [live("work_context", validWorkContextBody({ id: ROBIN_HOST_CONTEXT, sessionId: ROBIN_LIVE, title: HOST_TITLE, titleSource: "host", status: "implementing", createdAt: HOST_CREATED_AT, intent: { summary: "Make the refresh survive a key rotation", provenance: "declared", confidence: 1, capturedAt: nowIso(w) } }))], "intent"),
  },
  {
    name: "change a context's status",
    content: true,
    run: (w) => records(w, [live("work_context", validWorkContextBody({ id: ROBIN_HOST_CONTEXT, sessionId: ROBIN_LIVE, title: HOST_TITLE, titleSource: "host", status: "testing", createdAt: HOST_CREATED_AT }))], "status"),
  },
  {
    name: "publish a claim",
    content: true,
    run: (w) => records(w, [live("claim", validClaimBody({ id: "clm_robin_diff_new", workContextId: ROBIN_HOST_CONTEXT, authorSessionId: ROBIN_LIVE, kind: "observation", body: "Refresh retries hit the stale cache entry", createdAt: nowIso(w) }))], "claim"),
  },
  {
    name: "edit a file",
    content: true,
    run: (w) => records(w, [live("target", { workContextId: ROBIN_HOST_CONTEXT, kind: "file", value: "src/auth/keys.ts" })], "edit"),
  },
  {
    name: "pin a surface",
    content: true,
    run: (w) => post(w, "/api/pins", { id: "pin_robin_diff", repo: REPO, surface: "Rotation keeps sessions", files: ["src/auth/keys.ts"], check: "rotate, refresh, stay logged in", presence: "controlling_terminal", verifiedAtCommit: SECRET_SHA }, "pin"),
  },
];

interface Walked {
  readonly answers: readonly Answer[];
  readonly world: OptedOutWorld;
  /** When her action ran: an instant of hers like any secret of the seed. */
  readonly actionAt: string;
}

/** A world, her action (or none) at ACTION_DELAY_S, and Nick's walk READ_DELAY_S later. */
const walkWorld = async (action: Action | null): Promise<Walked> => {
  const world = await seedOptedOutWorld();
  world.harness.clock.advanceSeconds(ACTION_DELAY_S);
  const actionAt = nowIso(world);
  if (action !== null) {
    await action.run(world);
  }
  world.harness.clock.advanceSeconds(READ_DELAY_S);
  return { answers: await walk(world, "nick"), world, actionAt };
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** The seed's own session ids: fixed, so they are compared, never masked. */
const FIXED_UUID = /^(?:11111111|22222222|44444444|55555555|66666666|77777777|99999999|aaaaaaaa|bbbbbbbb)-/;

/** What differs between two worlds by construction: the random ids, keys and tokens each seed mints. */
const masked = (world: OptedOutWorld, text: string): string =>
  (
    [
      [world.nick.developerId, "<NICK>"],
      [world.ken.developerId, "<KEN>"],
      [world.robin.developerId, "<ROBIN>"],
      [world.nick.apiKey, "<NICK_KEY>"],
      [world.ken.apiKey, "<KEN_KEY>"],
      [world.robin.apiKey, "<ROBIN_KEY>"],
    ] as const
  )
    .reduce((out, [from, to]) => out.split(from).join(to), text)
    .replace(/value="[A-Za-z0-9_-]{24,}"/g, 'value="<token>"')
    .replace(/data-token="[0-9a-f]+"/g, 'data-token="<csrf>"')
    .replace(UUID, (uuid) => (FIXED_UUID.test(uuid) ? uuid : "<uuid>"));

const flatten = (value: unknown, prefix: string): readonly string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flatten(item, `${prefix}[]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      flatten(item, prefix === "" ? key : `${prefix}.${key}`),
    );
  }
  return [`${prefix}=${JSON.stringify(value)}`];
};

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** An answer as lines: status, headers, then its body — JSON flattened, SSE by event, HTML by tag. */
const linesOf = (world: OptedOutWorld, answer: Answer): readonly string[] => {
  const body = masked(world, answer.body);
  const head = [`status=${String(answer.status)}`, ...masked(world, answer.headers).split("\n").map((line) => `header ${line}`)];
  const json = parsed(body);
  if (json !== undefined) {
    return [...head, ...flatten(json, "")];
  }
  const events = body.split("\n").filter((line) => line.startsWith("data:"));
  if (events.length > 0) {
    return [...head, ...events.flatMap((line) => {
      const event = parsed(line.slice("data:".length));
      return event === undefined ? [line] : flatten(event, "event");
    })];
  }
  return [...head, ...body.split(/(?=<)/).map((part) => part.trim()).filter((part) => part.length > 0)];
};

/** Lines `after` gained or lost against `before`, as multisets; "~ order" when only the order moved. */
const differences = (before: readonly string[], after: readonly string[]): readonly string[] => {
  const count = (lines: readonly string[]): Map<string, number> =>
    lines.reduce((counts, line) => counts.set(line, (counts.get(line) ?? 0) + 1), new Map<string, number>());
  const a = count(before);
  const b = count(after);
  const removed = [...a].flatMap(([line, n]) => Array.from({ length: Math.max(0, n - (b.get(line) ?? 0)) }, () => `- ${line}`));
  const added = [...b].flatMap(([line, n]) => Array.from({ length: Math.max(0, n - (a.get(line) ?? 0)) }, () => `+ ${line}`));
  const reordered = removed.length === 0 && added.length === 0 && before.join("\n") !== after.join("\n") ? ["~ order"] : [];
  return [...removed, ...added, ...reordered];
};

/**
 * THE RESIDUALS: what one action of hers may change on a colleague's answer.
 * Each names the services/visibility.ts sentence (WHAT IT DOES NOT HIDE,
 * tagged «…») that accepts it. A residual may hold for some routes only, for
 * some actions only, or — `contentOnly` — for actions that share work.
 */
interface Residual {
  readonly name: string;
  /** Matched against the route key (`GET /api/pins`). Absent: every route. */
  readonly route?: RegExp;
  /** Matched against the differing line, `+ ` / `- ` / `~ ` included. */
  readonly line: RegExp;
  /** The actions it holds for. Absent: every action. */
  readonly actions?: readonly string[];
  readonly contentOnly?: true;
}

const RESIDUALS: readonly Residual[] = [
  // visibility.ts «coverage»: honest coverage that SOME session went quiet or
  // reported — the agent_event rung's state, its reason and whether its
  // start may be printed. Never whose, never when (session_withheld).
  { name: "coverage", line: /coverage\.sources\[\]\.(?:state|reason|gapSince)=/ },
  // visibility.ts «pilot»: team-level pilot counts — sessions, deliveries,
  // pulls and the integrity counters, and which prior work was opened.
  {
    name: "pilot",
    route: /^GET \/api\/(?:pilot\/report|hints\/stats)$/,
    line: /^[-+] data\.(?:sessionSet|cohorts|precision|integrity|duplicateWork|delivered|pulled)\b/,
  },
  // visibility.ts «landed»: that her work landed, to the day — the stamp,
  // and what changes because of it (the conference leaves landed work out,
  // the page says it landed).
  {
    name: "landed",
    actions: ["report landed work"],
    route: /^GET \/(?:api\/conference|api\/work-contexts(?:\/:id(?:\/diagnosis)?)?|api\/solved-matches|ui\/work-contexts\/:id)$/,
    line: /./,
  },
  // visibility.ts «evidence»: what her SessionStart's commit evidence found
  // counts for everyone (review round 5, C1) — the rung's state, reason and
  // the instant a viewer may be told, the absence findings — never when she
  // collected it.
  {
    name: "evidence",
    actions: ["report commit evidence"],
    line: /coverage\.sources\[\]\.(?:state|reason|observedAt)=|^[-+] data\.absences\[\]\./,
  },
  // visibility.ts «content» and «words»: what her shared work says — the
  // claim, the target's path, the intent's words, the pin's surface, a
  // reading's finding — and the counts and rankings that follow from it.
  // Never an instant of hers: that is checked on every line apart.
  { name: "content", contentOnly: true, line: /./ },
];

/**
 * The fields whose instant is the shared row's own creation (visibility.ts
 * «creation») — never a target's: its createdAt is when her session touched
 * the file, which is an edit instant, not a creation the policy accepts.
 */
const CREATION_FIELD = /(?:^[-+] |[.\]])(?:createdAt|solvedAt|expiresAt)=/;
const TARGET_ROW = /(?:matchedTargets|targets)\[\]\./;
const isCreationLine = (line: string): boolean => CREATION_FIELD.test(line) && !TARGET_ROW.test(line);

/** Every difference no residual accepts, for one action, as `action · route: line`. */
const unaccepted = (action: Action, base: Walked, acted: Walked): readonly string[] => {
  const now = acted.world.harness.clock.now();
  const actionInstant: readonly (readonly [string, string])[] = [["the instant of her action", acted.actionAt]];
  return acted.answers.flatMap((answer, index) => {
    const before = base.answers[index];
    if (before === undefined) {
      return [`${action.name} · ${label(answer)}: no answer in the base world`];
    }
    return differences(linesOf(base.world, before), linesOf(acted.world, answer)).flatMap((line) => {
      const accepted = RESIDUALS.some(
        (residual) =>
          residual.line.test(line) &&
          (residual.route === undefined || residual.route.test(answer.key)) &&
          (residual.actions === undefined || residual.actions.includes(action.name)) &&
          (residual.contentOnly !== true || action.content === true),
      );
      // A content line may carry her action's instant only as the shared
      // row's creation time — and only when the action shares work.
      const carriesHerInstant =
        instantsNear(line, actionInstant, now).length > 0 && !(action.content === true && isCreationLine(line));
      return accepted && !carriesHerInstant
        ? []
        : [`${action.name} · ${label(answer)}: ${carriesHerInstant ? "carries her action's instant: " : ""}${line.slice(0, 220)}`];
    });
  });
};

describe("one action of hers changes only what the policy names", () => {
  test("two identical worlds read identically — the masks leave no noise", async () => {
    const first = await walkWorld(null);
    const second = await walkWorld(null);

    const noise = first.answers.flatMap((answer, index) => {
      const other = second.answers[index];
      return other === undefined
        ? [`${label(answer)}: missing`]
        : differences(linesOf(first.world, answer), linesOf(second.world, other)).map((line) => `${label(answer)}: ${line.slice(0, 220)}`);
    });

    expect(noise).toEqual([]);
  }, 300_000);

  test.each(ACTIONS.map((action) => [action.name, action] as const))(
    "%s: every difference a colleague reads is a named residual, and no instant of hers",
    async (_name, action) => {
      const base = await walkWorld(null);
      const acted = await walkWorld(action);
      const now = acted.world.harness.clock.now();

      const problems = [
        ...unaccepted(action, base, acted),
        ...acted.answers.flatMap((answer) =>
          [...leaksIn(answer.body, now), ...leaksIn(answer.headers, now)].map(
            (secret) => `${action.name} · ${label(answer)}: leaks her ${secret}`,
          ),
        ),
      ];

      expect(problems).toEqual([]);
    },
    300_000,
  );
});
