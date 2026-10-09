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
  FILE,
  HOST_CREATED_AT,
  HOST_TITLE,
  NICK_CONTEXT,
  NICK_TO_ROBIN_QUESTION,
  OLD_CREATED_AT,
  OLD_TITLE,
  REPO,
  ROBIN_CONTEXT,
  ROBIN_FINGERPRINT,
  ROBIN_HOST_CONTEXT,
  ROBIN_LIVE,
  ROBIN_LOCAL,
  ROBIN_LOCAL_TOPIC,
  ROBIN_OLD_CONTEXT,
  ROBIN_TOPIC,
  SECRET_BRANCH,
  SECRET_LOCAL_TOPIC_BRANCH,
  SECRET_SHA,
  SECRET_TOPIC_BRANCH,
  SECRET_TOPIC_SHA,
  instantsNear,
  leaksIn,
  openTiedTopics,
  rewriteTiedTopicInPlace,
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
  /**
   * The rows this action CREATES, as the paths their creation instant sits
   * at (review round 5, M3): the only lines that may carry her action's
   * instant. Absent: it creates no row whose creation is shown.
   */
  readonly creates?: RegExp;
  readonly run: (world: OptedOutWorld) => Promise<void>;
}

/**
 * Where a claim's own creation instant sits on every route that lists one —
 * the row's `createdAt`, never a field nested inside the row (a session's,
 * an author's): those are not the claim's creation.
 */
const CLAIM_CREATION = /\.(?:claims|evidence|ruledOut)\[\]\.createdAt=|^[-+] data\.claim\.createdAt=/;

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
    // DESIGN.md "One session, many topics": her one session edits a sibling
    // worktree on another branch, and its context names that branch and its
    // base — her location as much as the session's own branch. Shared work
    // like any context; her branch and base never.
    name: "open a topic in a sibling worktree",
    content: true,
    run: (w) =>
      records(w, [
        live("work_context", validWorkContextBody({ id: ROBIN_TOPIC, sessionId: ROBIN_LIVE, title: `${SECRET_TOPIC_BRANCH} @ api`, titleSource: "fallback", status: "implementing", branch: SECRET_TOPIC_BRANCH, baseCommit: SECRET_TOPIC_SHA, baseOnDefault: true, description: "rotation window refresh topic", createdAt: CREATED_AT })),
        live("target", { workContextId: ROBIN_TOPIC, kind: "file", value: FILE }),
      ], "topic"),
  },
  {
    // The topic review's H4: on a `local:` repo a topic's title is its BARE
    // branch, and a build that sent no marker leaves the hub its shape to go
    // by — a branch her sessions never registered on.
    name: "open an unmarked topic on the local repo",
    content: true,
    run: (w) =>
      records(w, [
        recordEnvelope("work_context", validWorkContextBody({ id: ROBIN_LOCAL_TOPIC, sessionId: ROBIN_LOCAL, title: SECRET_LOCAL_TOPIC_BRANCH, status: "implementing", branch: SECRET_LOCAL_TOPIC_BRANCH, baseCommit: SECRET_TOPIC_SHA, description: "rotation window refresh scratch topic", createdAt: CREATED_AT }), { sessionId: ROBIN_LOCAL }),
        recordEnvelope("target", { workContextId: ROBIN_LOCAL_TOPIC, kind: "file", value: FILE }, { sessionId: ROBIN_LOCAL }),
      ], "local topic"),
  },
  {
    // set_intent on a topic, reaching the hub before the spool's copy: it
    // creates the topic whole — branch, base, the connector's own marker.
    name: "set an intent on a topic",
    content: true,
    run: (w) =>
      records(w, [
        live("work_context", validWorkContextBody({ id: ROBIN_TOPIC, sessionId: ROBIN_LIVE, title: `${SECRET_TOPIC_BRANCH} @ api`, titleSource: "fallback", status: "testing", branch: SECRET_TOPIC_BRANCH, baseCommit: SECRET_TOPIC_SHA, createdAt: CREATED_AT, intent: { summary: "Keep the rotated key id through the cache", provenance: "declared", confidence: 1, capturedAt: nowIso(w) } })),
      ], "topic intent"),
  },
  {
    name: "change a context's status",
    content: true,
    run: (w) => records(w, [live("work_context", validWorkContextBody({ id: ROBIN_HOST_CONTEXT, sessionId: ROBIN_LIVE, title: HOST_TITLE, titleSource: "host", status: "testing", createdAt: HOST_CREATED_AT }))], "status"),
  },
  {
    // Nick's question to her (seeded), answered: the answer is a claim — her
    // shared work, created now — and the row Nick's briefing and prompt list
    // for it carried when she answered and how old the failure it cites is
    // (batch-2 integration review, M4).
    // The claim is dated at a published instant, so only the answer's own
    // row can carry hers.
    name: "answer a colleague's question",
    content: true,
    run: (w) =>
      post(w, `/api/questions/${NICK_TO_ROBIN_QUESTION}/answers`, {
        claim: validClaimBody({ id: "clm_robin_diff_answer", workContextId: ROBIN_CONTEXT, authorSessionId: ROBIN_LIVE, kind: "observation", body: "The cache keeps the old key id for one refresh", verificationRef: `error_fingerprint:${ROBIN_FINGERPRINT}`, createdAt: CREATED_AT }),
      }, "answer"),
  },
  {
    name: "publish a claim",
    content: true,
    creates: CLAIM_CREATION,
    run: (w) => records(w, [live("claim", validClaimBody({ id: "clm_robin_diff_new", workContextId: ROBIN_HOST_CONTEXT, authorSessionId: ROBIN_LIVE, kind: "observation", body: "Refresh retries hit the stale cache entry", createdAt: nowIso(w) }))], "claim"),
  },
  {
    name: "edit a file",
    content: true,
    run: (w) => records(w, [live("target", { workContextId: ROBIN_HOST_CONTEXT, kind: "file", value: "src/auth/keys.ts" })], "edit"),
  },
  {
    // A file her old context already holds, touched again: nothing new is
    // learned, only WHEN she was there — the re-touch moves the target's
    // last_seen_at (the landed branch's targetTouchedAt), which suspect, the
    // conference and the ghost sweep window by for owners they may see.
    name: "touch a file again",
    run: (w) => records(w, [live("target", { workContextId: ROBIN_OLD_CONTEXT, kind: "file", value: FILE })], "re-touch"),
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

/**
 * A coverage row by its rung (`coverage.sources[agent_event]`), so a residual
 * can name the rung it accepts: the agent rung's start and the git rung's
 * are different facts (review round 5, M3).
 */
const memberKey = (prefix: string, item: unknown): string => {
  const source = prefix.endsWith(".sources") && item !== null && typeof item === "object" ? (item as { source?: unknown }).source : undefined;
  return typeof source === "string" ? `${prefix}[${source}]` : `${prefix}[]`;
};

const flatten = (value: unknown, prefix: string): readonly string[] => {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flatten(item, memberKey(prefix, item)));
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
  // reported — the agent_event rung's state, its reason and whether the gap
  // is withheld. Never whose, never when: its start is NOT here (review
  // round 5, M3) — nothing she does may move it.
  // The order block reads the same window (services/coverage-order.ts): no
  // session in it, or the weakest declaration of those in it — some session's,
  // never whose. Moved only by WHEN she last reported, which the timed walks
  // below compare; one action of hers inside the window never moves it.
  { name: "coverage", line: /coverage\.sources\[agent_event\]\.(?:state|reason|withheld)=|coverage\.order\.(?:state|reason)=/ },
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
  // counts for everyone (review round 5, C1) — the git rung's state, reason,
  // the instant a viewer may be told and the start the census names (an
  // absentee's, never hers), the absence findings — never when she
  // collected it.
  {
    name: "evidence",
    actions: ["report commit evidence"],
    line: /coverage\.sources\[git\]\.(?:state|reason|observedAt|gapSince)=|^[-+] data\.absences\[\]\./,
  },
  // visibility.ts «content» and «words»: what her shared work says — the
  // claim, the target's path, the intent's words, the pin's surface, a
  // reading's finding — and the counts and rankings that follow from it.
  // Never an instant of hers: that is checked on every line apart.
  { name: "content", contentOnly: true, line: /./ },
];

/**
 * A line that is the creation instant of a row THIS action created
 * (visibility.ts «creation»), at that row's own path (Action.creates) — never
 * a field of the same name nested in it, never a row that existed before
 * (review round 5, M3: a context whose createdAt became her heartbeat read
 * as a creation), and never a target's: its createdAt is when her session
 * touched the file, an edit instant the policy does not accept.
 */
const TARGET_ROW = /(?:matchedTargets|targets)\[\]\./;
const isCreationLine = (action: Action, line: string): boolean =>
  action.creates !== undefined && action.creates.test(line) && !TARGET_ROW.test(line);

/** Does one of `residuals` accept this differing line of `answer`, for `action`? */
const acceptedBy = (residuals: readonly Residual[], action: Action, answer: Answer, line: string): boolean =>
  residuals.some(
    (residual) =>
      residual.line.test(line) &&
      (residual.route === undefined || residual.route.test(answer.key)) &&
      (residual.actions === undefined || residual.actions.includes(action.name)) &&
      (residual.contentOnly !== true || action.content === true),
  );

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
      const accepted = acceptedBy(RESIDUALS, action, answer, line);
      // A content line may carry her action's instant only as the shared
      // row's creation time — and only when the action shares work.
      const carriesHerInstant =
        instantsNear(line, actionInstant, now).length > 0 && !(action.content === true && isCreationLine(action, line));
      return accepted && !carriesHerInstant
        ? []
        : [`${action.name} · ${label(answer)}: ${carriesHerInstant ? "carries her action's instant: " : ""}${line.slice(0, 220)}`];
    });
  });
};

/** Every line two worlds' walks differ by, as `route: line` — no residual applied. */
const between = (first: Walked, second: Walked): readonly { readonly answer: Answer; readonly line: string }[] =>
  first.answers.flatMap((answer, index) => {
    const other = second.answers[index];
    return other === undefined
      ? [{ answer, line: "missing" }]
      : differences(linesOf(first.world, answer), linesOf(second.world, other)).map((line) => ({ answer, line }));
  });

const shown = ({ answer, line }: { readonly answer: Answer; readonly line: string }): string =>
  `${label(answer)}: ${line.slice(0, 220)}`;

describe("one action of hers changes only what the policy names", () => {
  test("two identical worlds read identically — the masks leave no noise", async () => {
    const first = await walkWorld(null);
    const second = await walkWorld(null);

    expect(between(first, second).map(shown)).toEqual([]);
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

/**
 * WHEN SHE ACTED, AND NOTHING ELSE (batch-2 integration review, H5). Every
 * case above compares a world with her action against one without it, and a
 * content action may change what follows from its words — which hid a hint
 * ranking by her withheld last touch behind the content residual. These
 * compare two worlds with the SAME action, twenty days and two minutes before
 * Nick reads (both past the presence TTL, so she is quiet in both): whatever
 * differs follows from when she acted alone. Only «coverage» may, and neither
 * instant may show.
 */
const SECONDS_PER_DAY = 86_400;
const SKEW_S = 20 * SECONDS_PER_DAY;
const LATE_S = 120;

const TIMED_ACTIONS: readonly Action[] = [
  {
    // The review's probe: her old context — outside every window by its
    // creation — moved again, which only her last touch could rank by.
    name: "change her old context's status",
    content: true,
    run: (w) =>
      records(w, [live("work_context", validWorkContextBody({ id: ROBIN_OLD_CONTEXT, sessionId: ROBIN_LIVE, title: OLD_TITLE, titleSource: "host", status: "testing", createdAt: OLD_CREATED_AT }))], "old status"),
  },
  ...ACTIONS.filter((action) => ["change a context's status", "set an intent", "touch a file again"].includes(action.name)),
];

/** A world where her action runs `beforeReadS` before Nick's walk, which reads SKEW_S after the seed. */
const timedWorld = async (action: Action, beforeReadS: number): Promise<Walked> => {
  const world = await seedOptedOutWorld();
  world.harness.clock.advanceSeconds(ACTION_DELAY_S + SKEW_S - beforeReadS);
  const actionAt = nowIso(world);
  await action.run(world);
  world.harness.clock.advanceSeconds(beforeReadS);
  return { answers: await walk(world, "nick"), world, actionAt };
};

/** «coverage» and «pilot»: the window's honest coverage and the team's integrity counters that count it. */
const COVERAGE_ONLY: readonly Residual[] = RESIDUALS.filter((residual) => residual.name === "coverage" || residual.name === "pilot");

describe("when she acted, and nothing else, changes nothing a colleague reads", () => {
  test.each(TIMED_ACTIONS.map((action) => [action.name, action] as const))(
    "%s, twenty days or two minutes before the read: only coverage differs, and neither instant shows",
    async (_name, action) => {
      const early = await timedWorld(action, SKEW_S);
      const late = await timedWorld(action, LATE_S);
      const now = late.world.harness.clock.now();
      const instants: readonly (readonly [string, string])[] = [
        ["her action twenty days back", early.actionAt],
        ["her action two minutes back", late.actionAt],
      ];

      const problems = [
        ...between(early, late)
          .filter((difference) => !acceptedBy(COVERAGE_ONLY, action, difference.answer, difference.line))
          .map(shown),
        ...[...early.answers, ...late.answers].flatMap((answer) =>
          instantsNear(`${answer.body}\n${answer.headers}`, instants, now).map((instant) => `${label(answer)}: carries ${instant}`),
        ),
      ];

      expect(problems).toEqual([]);
    },
    300_000,
  );
});

/**
 * HER ROWS' PLACE ON DISK IS NO ORDER (batch-2 integration review, L7).
 * Equally ranked candidates fell to the order the scan met them in, so an
 * update of hers that changed nothing a colleague may read — a status resent,
 * a heartbeat — moved a tuple and reordered his bounded hint list (the twin
 * probe saw it follow the byte length of her branch names). Two of her topics
 * say the same words (opted-out-world.ts openTiedTopics); the second world
 * rewrites one of them, its claim and her live session in place.
 */
const tiedWorld = async (isRewritten: boolean): Promise<Walked> => {
  const world = await seedOptedOutWorld();
  await openTiedTopics(world);
  world.harness.clock.advanceSeconds(ACTION_DELAY_S);
  const actionAt = nowIso(world);
  if (isRewritten) {
    await rewriteTiedTopicInPlace(world);
  }
  world.harness.clock.advanceSeconds(READ_DELAY_S);
  return { answers: await walk(world, "nick"), world, actionAt };
};

describe("her rows' place on disk orders nothing a colleague reads", () => {
  test("a rewrite of her rows that changes no value changes no answer", async () => {
    const base = await tiedWorld(false);
    const rewritten = await tiedWorld(true);

    expect(between(base, rewritten).map(shown)).toEqual([]);
  }, 300_000);
});
