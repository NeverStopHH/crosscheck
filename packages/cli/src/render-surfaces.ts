/**
 * The CLI package's render-surface registration (§4.4 of
 * DESIGN-agent-agnostic.md). Same contract as connector-core's
 * src/render-surfaces.ts: every module in this package that touches the
 * render layer appears here, and the meta-test
 * (connector-core/test/render-surface-registry.test.ts) fails the build on
 * one that does not. Both entries MOVED with their modules from
 * connector-claude's registry when Block 8 extracted `packages/cli`.
 */
import type { RenderSurface } from "@crosscheck/connector-core/render-surfaces.ts";
import type {
  PinEntry,
  PinRegistry,
  SuspectCandidate,
  SuspectView,
} from "@crosscheck/connector-core/http/hub.ts";

import { renderPinList } from "./cli/pin-render.ts";
import { pinStatusLines } from "./cli/pin-observability.ts";
import { renderSuspect } from "./cli/suspect-render.ts";
import { hubFailureLine } from "./cli/revalidate.ts";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const ISO = "2026-08-25T11:00:00.000Z";

/** The payload in every untrusted slot at once — the corpus adapter rule. */
const pinWith = (payload: string): PinEntry => ({
  id: "pin_11111111-2222-4333-8444-555555555555",
  repo: payload,
  surface: payload,
  files: [{ path: payload, status: "missing" }],
  check: payload,
  captureMode: payload,
  verifiedById: "dev_other",
  verifiedByName: payload,
  verifiedAtCommit: payload,
  verifiedAt: ISO,
  brokeAt: ISO,
  brokeByName: payload,
  speaking: true,
  missingPaths: 1,
  // SWEPT, so the rewrite clause on the trust line — which interpolates the
  // sweeping developer's name — is in the corpus rather than merely written.
  renamedPaths: 1,
  renamedAt: ISO,
  renamedByName: payload,
});

/**
 * A LIVE pin, because the two lines that interpolate untrusted text at all —
 * the denylist-shadow sentence and the orphan sentence — skip retracted pins
 * by design. A corpus run over a retracted registry would render neither and
 * report itself green over the exact spans it exists to attack.
 */
const livePinWith = (payload: string): PinEntry => ({
  ...pinWith(payload),
  brokeAt: null,
  brokeByName: null,
});

const liveRegistryWith = (payload: string): PinRegistry => ({
  pins: [livePinWith(payload)],
  coverage: {
    pins: 1,
    files: 1,
    speaking: 0,
    broken: 0,
    missingPaths: 1,
    oldestVerifiedAt: ISO,
  },
});

const registryWith = (payload: string): PinRegistry => ({
  pins: [pinWith(payload)],
  coverage: {
    pins: 1,
    files: 1,
    speaking: 1,
    broken: 1,
    missingPaths: 1,
    oldestVerifiedAt: ISO,
  },
});

const candidateWith = (payload: string): SuspectCandidate => ({
  sessionId: "cc_11111111-2222-4333-8444-555555555555",
  agentKind: payload,
  branch: payload,
  workContextId: "wc_cc_11111111-2222-4333-8444-555555555555",
  workContextTitle: payload,
  intent: {
    summary: payload,
    provenance: "derived",
    confidence: 0.4,
    capturedAt: ISO,
  },
  lastActiveAt: ISO,
  overlap: 2,
  authorTouches: 3,
  lift: 0.67,
  sources: [payload],
  intentTiming: null,
  readerMuted: true,
  isSelf: false,
});

const suspectWith = (payload: string): SuspectView => ({
  outcome: "ranked",
  falsifier: { kind: "recorded_break", at: ISO, check: payload },
  scope: {
    kind: "pin",
    pinId: "pin_11111111-2222-4333-8444-555555555555",
    surface: payload,
    files: [payload],
    // The SAME payload, so the (MISSING) marker the dead-path branch adds is
    // planted in the corpus rather than being a rendering nobody ever fuzzed.
    missingFiles: [payload],
    // A swept pin, so the rewrite sentence is in the corpus too.
    rewrittenPaths: 1,
    rewrittenAt: ISO,
  },
  totals: { sessionsTouching: 1, sessionsScored: 1, windowDays: 14 },
  attribution: "sessions",
  candidates: [candidateWith(payload)],
  // A FIXED `incomplete` record (03 COV-7): the coverage clause lands on this
  // surface too, and it carries the only instants on it that come off the
  // wire rather than out of a renderer. `incomplete` because that is the
  // state with the most renderer-owned text and the only one with a gap
  // instant to attack.
  coverage: {
    repo: "github.com/acme/api",
    computedAt: NOW.toISOString(),
    scope: { sinceIso: ISO, paths: [payload] },
    sources: [
      {
        source: "agent_event",
        state: "incomplete",
        reason: "session_reaped",
        gapSince: payload,
        observedAt: payload,
      },
      {
        source: "git",
        state: "incomplete",
        reason: "evidence_stale",
        gapSince: payload,
        observedAt: payload,
      },
      { source: "ci", state: "unavailable", reason: "no_emitter", gapSince: null, observedAt: null },
      { source: "runtime", state: "unavailable", reason: "out_of_scope_1_0", gapSince: null, observedAt: null },
      { source: "human_edit", state: "unavailable", reason: "no_platform_rung", gapSince: null, observedAt: null },
    ],
  },
});

export const RENDER_SURFACES: readonly RenderSurface[] = [
  {
    kind: "corpus",
    name: "cli-pin-observability",
    delivery: "pulled",
    module: "src/cli/pin-observability.ts",
    // BARE, deliberately, and it is the reason this module exists apart from
    // the listing: `status` and `doctor` print PATHS and GLOB PATTERNS, which
    // are bare tokens, and never a pin's surface label or check recipe, which
    // are another person's prose. So these lines carry no frame at all — and
    // the corpus holds them to it, over the pinned path, the denylist pattern
    // and both team-setting values at once.
    framing: "bare",
    render: (payload) =>
      pinStatusLines(
        liveRegistryWith(payload),
        [payload],
        {
          repo: payload,
          pinPolicy: payload,
          suspectAttribution: payload,
          updatedAt: ISO,
        },
        NOW,
      ).join("\n"),
  },
  {
    kind: "corpus",
    name: "cli-pin-list",
    delivery: "pulled",
    module: "src/cli/pin-render.ts",
    framing: "framed",
    // `crosscheck pin list` quotes OTHER PEOPLE'S PROSE — a surface label and
    // a check recipe somebody typed — and an agent asked "what is watched
    // here" runs exactly this command through Bash. So unlike `status` it
    // carries the quoted-data notice, and the corpus holds it to the framed
    // class on every payload.
    render: (payload) => renderPinList(payload, registryWith(payload), NOW),
  },
  {
    kind: "corpus",
    name: "cli-suspect",
    delivery: "pulled",
    module: "src/cli/suspect-render.ts",
    framing: "framed",
    // The one surface in Stage 1 that renders a teammate's declared INTENT
    // beside an attribution. Every untrusted slot at once: the surface label,
    // the check recipe, the file names, the work-context title, the intent,
    // the agent kind, the branch and the evidence-source labels.
    render: (payload) => renderSuspect(suspectWith(payload), NOW),
  },
  {
    kind: "composite",
    name: "cli-doctor",
    delivery: "pulled",
    module: "src/cli/doctor.ts",
    // COV-7 for this closure: a CompositeRenderSurface has no `render`, so the
    // coverage clause cannot be attacked through the registry the way
    // search-results-empty-filtered's closure is. It is driven instead by
    // named fixtures in test/coverage-cli.test.ts, which run the real command
    // against a hub serving a fixed incomplete record.
    //
    // BOTH BRANCHES CORRECTED THIS NOTE, and both corrections are kept. 03
    // added the coverage clause and where it is attacked; 02 removed the words
    // "no untrusted interpolation", which were true of every sentence this
    // command WRITES and false of the three it PASSES THROUGH. Taking either
    // side alone would have restored a claim the other branch had just proven
    // false.
    note: "formatAge on renderer-built ages, the coverage clause from enum-derived states, and `hubSaid` (bareUntrusted at MAX_HUB_MESSAGE_CHARS) on the one thing this command does not write itself: the hub's own failure sentence, printed by the coverage, claim-currency and hub-reachable checks. The capture check prints the developer's OWN local paths and host tool names, control-stripped and capped (DOCTOR_PATH_MAX_CHARS / DOCTOR_TOOL_NAME_MAX_CHARS), never teammate text. Coverage states and printed refusals are exercised in test/coverage-cli.test.ts",
  },
  {
    kind: "composite",
    name: "cli-conference",
    delivery: "pulled",
    module: "src/cli/conference.ts",
    note: "the command's own stdout, not the page: the tree owner's display name through bareUntrusted before it is printed or composed into a draft body, and formatAge on a renderer-built age. The report itself is rendered by connector-core's registered conference-report surface, and the model's sentence reaches both already bounded, echo-checked and secret-scanned",
  },
  {
    kind: "composite",
    name: "cli-status",
    delivery: "pulled",
    module: "src/cli/status.ts",
    // COV-7, same shape as cli-doctor above: driven by named fixtures in
    // test/coverage-cli.test.ts rather than by a registry closure.
    note: "formatAbsenceLine, formatAge and the coverage clause from the core render layer, the clause exercised in test/coverage-cli.test.ts; absence names sanitized inside the renderer; teammate name/branch/status through bareUntrusted and the session intent through renderIntent (the one framed fragment). NO QUOTED_DATA_NOTICE, deliberately: the notice tells a MODEL that « » is data rather than instruction, and this command's stdout reaches a human terminal only — no hook and no MCP tool reads it (VERIFY below). The frame, the sanitizing and the bounds still apply, because they protect the reader's terminal rather than a context window",
  },
  {
    kind: "corpus",
    name: "cli-claim-revalidate",
    delivery: "pulled",
    module: "src/cli/revalidate.ts",
    // BARE, for cli-pin-observability's reason: this command's stdout is
    // counts, validity ENUM WORDS and one hub-chosen failure string, and
    // none of them is another person's prose to frame. `crosscheck
    // revalidate` prints no claim id, no claim body, no path, no teammate
    // and not even the repo — which claims went stale, and the commits that
    // did it, stay on the diagnosis surface where a reader pulled for them.
    // So the corpus has exactly ONE slot to attack, and this adapter plants
    // in it: the hub's error message, bounded by MAX_HUB_MESSAGE_CHARS, the
    // constant written for precisely this ("a string THE HUB chose, as a
    // tool prints it back").
    framing: "bare",
    render: (payload) => hubFailureLine(payload),
  },
];

/**
 * The claim above that nothing machine-facing reads `crosscheck status`: no
 * hook and no MCP tool imports it. If one ever does, its output becomes model
 * context and the quoted-data notice stops being optional.
 *
 * AN IMPORT, not a mention. This grepped for the bare string until
 * state/capture-health.ts named both CLI surfaces in a comment about who does
 * the formatting — a true sentence that the check read as a layering
 * violation. A directive that goes red for prose is one somebody eventually
 * silences, so it now matches the two ways a module can actually reach the
 * surface (`from "…cli/status…"` and `import("…cli/status…")`), verified
 * against both spellings and against a comment that must NOT match.
 *
 * VERIFY: grep -rlE '(from|import\()[^"]*"[^"]*cli/status' packages/connector-claude/src packages/connector-core/src | wc -l | tr -d ' '
 * PRINTS: 0
 */
