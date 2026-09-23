/**
 * Rendering for `get_referee_brief` — the third MCP surface that puts other
 * developers' text into the reader's context, under the same three untrusted
 * classes as the other two (mcp/render.ts states them): PROSE inside « »
 * (`quoted`), short fields BARE (`bare`), ids through the allowlist
 * (`safeId`). No fourth path.
 *
 * NEUTRALITY IS STRUCTURAL, three ways. One `renderPosition` renders both
 * sides, so the two blocks cannot differ in fields, order or framing. Every
 * budget is PER SECTION (constants.ts MAX_REFEREE_*) rather than one document
 * cap, because a shared cap spends itself on whichever position renders first
 * — the later side would truncate more exactly when the case file is fullest.
 * And the A/B labels are assigned HERE, by canonical claim-id order, never
 * taken from the hub's pair order — so which side the hub happened to store
 * first cannot influence a single byte of the document. That last one is what
 * makes the swap-invariance test (test/mcp-referee-render.test.ts) byte-exact:
 * rendering with the positions exchanged yields the IDENTICAL document.
 *
 * THE TIMELINE IS DERIVED HERE, not shipped: every claim in the brief carries
 * its author and createdAt, and a second copy of those facts on the wire
 * would be a second thing able to disagree with the first (server referee.ts
 * says the same from its side). Sorting is by (createdAt, id) — never by
 * side, which is what keeps the timeline swap-invariant. Ages are
 * renderer-built (`formatAge`), never echoed hub strings; an entry whose
 * createdAt does not parse is skipped, like the briefing's absence lines.
 */
import { MAX_CLAIM_BODY_LENGTH } from "@crosscheck/schema";

import {
  MAX_REFEREE_POSITION_CHARS,
  MAX_REFEREE_SHARED_CHARS,
  MAX_REFEREE_TIMELINE_CHARS,
  MAX_WORK_CONTEXT_TITLE_CHARS,
} from "../constants.ts";
import { QUOTED_DATA_NOTICE, formatAge } from "../briefing/render.ts";
import {
  NO_AXES_FROM_HUB,
  NO_AXES_READABLE,
  axesLabel,
} from "@crosscheck/schema";
import { bareUntrusted as bare, safeId } from "../briefing/sanitize.ts";
import {
  CONFIDENCE_DECIMALS,
  UNNAMED_AUTHOR,
  appendSection,
  claimValidityClause,
  countHeader,
  quoted,
  quotedBody,
} from "./render.ts";
import type {
  RefereeBrief,
  RefereeClaim,
  RefereePosition,
} from "../http/hub.ts";

/**
 * Ceiling of a rendered brief: the opening block plus every per-section
 * budget. The opening is renderer-built prose whose only interpolations are
 * capped (safeId ≤ 64 chars, one fixed-decimal number), so the allowance
 * covers it with room:
 *
 * VERIFY: bun -e 'const c=await import("./packages/connector-core/src/mcp/render-referee.ts");const k=await import("./packages/connector-core/src/constants.ts");console.log(c.MAX_REFEREE_BRIEF_CHARS === k.MAX_REFEREE_POSITION_CHARS*2 + k.MAX_REFEREE_SHARED_CHARS + k.MAX_REFEREE_TIMELINE_CHARS + 800)'
 * PRINTS: true
 */
const OPENING_ALLOWANCE_CHARS = 800;
export const MAX_REFEREE_BRIEF_CHARS =
  MAX_REFEREE_POSITION_CHARS * 2 +
  MAX_REFEREE_SHARED_CHARS +
  MAX_REFEREE_TIMELINE_CHARS +
  OPENING_ALLOWANCE_CHARS;

type PositionLabel = "A" | "B";

const authorOf = (claim: RefereeClaim): string => {
  const name =
    claim.authorDeveloperName === undefined
      ? ""
      : bare(claim.authorDeveloperName);
  return name.length === 0 ? UNNAMED_AUTHOR : name;
};

const claimLine = (claim: RefereeClaim): string =>
  [
    `- ${safeId(claim.id)}`,
    bare(claim.kind),
    `status ${bare(claim.status)}`,
    `confidence ${claim.confidence.toFixed(CONFIDENCE_DECIMALS)}`,
    // 08 §3.6 — the number never stands alone on a brief whose whole purpose
    // is letting a reader CHECK a position rather than believe it.
    //
    // THE SHORT LABEL, though this is a pulled surface and the full clause
    // would be allowed. This brief keeps every age in ONE place, its timeline
    // section — `claimLine` takes no clock for exactly that reason — and a
    // second time vocabulary on a claim line would read as a different fact
    // about the same instant. The rung is what a reader needs beside the
    // number; the when is downstairs.
    ...(claim.axes === undefined
      ? [NO_AXES_FROM_HUB]
      : [axesLabel(claim.axes) || NO_AXES_READABLE]),
    // Trust label (DESIGN.md §4), bare like the hint renderer's: without it a
    // machine draft reads identically to a human-vouched declared claim.
    `provenance ${bare(claim.provenance)}`,
    `${authorOf(claim)}: ${quotedBody(claim.body, MAX_CLAIM_BODY_LENGTH)}`,
  ].join(" · ");

const plural = (count: number, singular: string, pluralForm: string): string =>
  `${String(count)} ${count === 1 ? singular : pluralForm}`;

const evidenceLines = (
  label: PositionLabel,
  position: RefereePosition,
): readonly string[] => [
  position.evidence.length === 0
    ? `Position ${label} cites no evidence claims.`
    : `Position ${label} cites ${plural(position.evidence.length, "evidence claim", "evidence claims")}:`,
  ...position.evidence.map(claimLine),
  ...(position.evidenceTruncated
    ? [`(the hub capped position ${label}'s evidence list)`]
    : []),
];

const ruledOutLines = (
  label: PositionLabel,
  position: RefereePosition,
): readonly string[] => [
  position.ruledOut.length === 0
    ? `Position ${label} has no ruled-out approaches recorded.`
    : `Position ${label} ruled out ${plural(position.ruledOut.length, "approach", "approaches")}:`,
  ...position.ruledOut.map(claimLine),
  ...(position.ruledOutTruncated
    ? [`(the hub capped position ${label}'s ruled-out list)`]
    : []),
];

/**
 * ONE function for both sides — the header of this file says why. The claim
 * line comes first inside the budget, so the "(+N lines not shown)" fallback
 * can only ever cost evidence or ruled-out lines, never the position itself
 * (the budget always fits header + claim, asserted arithmetically in the
 * render test).
 */
const renderPosition = (
  label: PositionLabel,
  position: RefereePosition,
): readonly string[] => {
  const header = `Position ${label} · ${authorOf(position.claim)} · work context ${safeId(position.claim.workContextId)}: ${quoted(position.workContextTitle, MAX_WORK_CONTEXT_TITLE_CHARS)}`;
  // The validity clause on its OWN line, directly under the position's claim.
  // This is the cheapest surface to wire — the record is half-built already,
  // since `supersededByClaimId` was computed here before this spec — and it
  // is a case file a HUMAN decides from, so the standing of each position
  // belongs beside it rather than in a column. The clause is renderer-built
  // (enum values, small integers, hex through safeId) and opens no new
  // untrusted slot; the section's own budget fits header + claim first, so
  // this line is droppable before either of those.
  const validity = claimValidityClause(position.validity ?? undefined);
  const lines = [
    claimLine(position.claim),
    ...(validity === null ? [] : [`Position ${label} is ${validity}`]),
    ...evidenceLines(label, position),
    ...ruledOutLines(label, position),
  ];
  return appendSection(
    [],
    {
      header,
      rows: lines.map((line) => () => line),
      total: lines.length,
      noun: "line",
    },
    MAX_REFEREE_POSITION_CHARS,
  );
};

const sharedGroundLines = (brief: RefereeBrief): readonly string[] => {
  if (brief.sharedTargets.length === 0) {
    return ["No shared targets between the two work contexts."];
  }
  const lines = brief.sharedTargets.map(
    (target) => `- ${bare(target.kind)} · ${bare(target.value)}`,
  );
  const fitted = appendSection(
    [],
    {
      header: countHeader(
        "Shared ground — targets both work contexts touch",
        brief.sharedTargets.length,
      ),
      rows: lines.map((line) => () => line),
      total: brief.sharedTargets.length,
      noun: "target",
    },
    MAX_REFEREE_SHARED_CHARS,
  );
  return brief.sharedTargetsTruncated
    ? [...fitted, "(the hub capped the shared-target list)"]
    : fitted;
};

interface TimelineEntry {
  readonly line: string;
  /**
   * Side-independent sort key with the LABEL LAST: (createdAt, claimId,
   * role, label). One claim may legitimately appear on both sides — claim
   * ids are hub-wide, so shared evidence is real — and a tie broken by
   * anything side-dependent would reorder under an A/B swap. With the label
   * as the final component, the A-entry of a shared claim always precedes
   * the B-entry, whichever position was handed in first.
   */
  readonly sortKey: string;
}

const timelineEntry = (
  claim: RefereeClaim,
  role: string,
  label: PositionLabel,
  now: Date,
): TimelineEntry | null => {
  const createdMs = Date.parse(claim.createdAt);
  if (Number.isNaN(createdMs)) {
    return null;
  }
  const age = formatAge(now.getTime() - createdMs);
  return {
    line: `- ${age} ago · ${authorOf(claim)} · ${role} position ${label} · ${bare(claim.kind)} ${safeId(claim.id)}`,
    // JSON.stringify of the parts, not a separator character. A separator is
    // a guess about what the parts cannot contain, and the guess here was a
    // literal NUL — which made this whole MODULE grep as binary, so every
    // `grep -r … packages/*/src` in the tree silently skipped it, including
    // the guards that count render sites. A sort key needs to be unambiguous,
    // not exotic.
    sortKey: JSON.stringify([claim.createdAt, claim.id, role, label]),
  };
};

const positionEntries = (
  label: PositionLabel,
  position: RefereePosition,
  now: Date,
): readonly (TimelineEntry | null)[] => [
  timelineEntry(position.claim, "stated", label, now),
  ...position.evidence.map((claim) =>
    timelineEntry(claim, "cited for", label, now),
  ),
  ...position.ruledOut.map((claim) =>
    timelineEntry(claim, "ruled out for", label, now),
  ),
];

/** Sorted by the side-independent key above — never by input order. */
const timelineLines = (brief: RefereeBrief, now: Date): readonly string[] => {
  const entries = [
    ...positionEntries("A", brief.positionA, now),
    ...positionEntries("B", brief.positionB, now),
  ]
    .filter((entry): entry is TimelineEntry => entry !== null)
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey));
  if (entries.length === 0) {
    return [];
  }
  return appendSection(
    [],
    {
      header: countHeader("Timeline, oldest first", entries.length),
      rows: entries.map((entry) => () => entry.line),
      total: entries.length,
      noun: "event",
    },
    MAX_REFEREE_TIMELINE_CHARS,
  );
};

/**
 * How the hub found the pair — branched on, never echoed: `reason` is a hub
 * string, and an unknown value gets the generic sentence rather than a place
 * in the reader's context.
 */
const detectionLine = (brief: RefereeBrief): string => {
  if (brief.similarity !== null) {
    return `Detected by semantic similarity ${brief.similarity.toFixed(CONFIDENCE_DECIMALS)}.`;
  }
  return brief.reason === "shared_target"
    ? "Detected by a shared target held with opposite statuses."
    : "Detected by the hub's contradiction gate.";
};

/**
 * Retirement honesty (VISION.md §4): a side revised away by its own author is
 * said FIRST, before either position — the single most useful fact a brief
 * can carry is that the deadlock may already be over.
 */
const retirementNotes = (brief: RefereeBrief): readonly string[] =>
  (
    [
      ["A", brief.positionA],
      ["B", brief.positionB],
    ] satisfies readonly (readonly [PositionLabel, RefereePosition])[]
  ).flatMap(([label, position]) =>
    position.supersededByClaimId === null
      ? []
      : [
          `Note: position ${label} was superseded by its author (see claim ${safeId(position.supersededByClaimId)}) — this deadlock may already be over.`,
        ],
  );

const completenessNotes = (brief: RefereeBrief): readonly string[] =>
  brief.droppedRows > 0
    ? [
        `Note: ${String(brief.droppedRows)} rows the hub sent could not be read and were dropped.`,
      ]
    : [];

/**
 * Canonical pair order — by claim id, then work context, then createdAt —
 * so the labels depend only on the claims, never on which side the hub
 * listed first. A full tie means two byte-identical position keys, which no
 * honest hub produces; input order then stands.
 */
const canonicalPair = (
  brief: RefereeBrief,
): readonly [RefereePosition, RefereePosition] => {
  const keyOf = (position: RefereePosition): string =>
    [
      position.claim.id,
      position.claim.workContextId,
      position.claim.createdAt,
    ].join(" ");
  return keyOf(brief.positionA) <= keyOf(brief.positionB)
    ? [brief.positionA, brief.positionB]
    : [brief.positionB, brief.positionA];
};

/** One referee case file, as markdown-ish text for an agent to read. */
export const renderRefereeBrief = (brief: RefereeBrief, now: Date): string => {
  const [first, second] = canonicalPair(brief);
  const ordered: RefereeBrief = {
    ...brief,
    positionA: first,
    positionB: second,
  };
  const opening = [
    `crosscheck referee brief for contradiction ${safeId(ordered.id)}. ${QUOTED_DATA_NOTICE}`,
    // Never "two developers": a similarity pair can hold ONE developer's own
    // opposite-status claims (the hub's gate flags a developer against their
    // own history), and the wire carries no assertion about author count.
    "Two positions conflict; this is the case file — crosscheck does not rank them.",
    detectionLine(ordered),
    ...retirementNotes(ordered),
  ];
  return [
    ...opening,
    ...renderPosition("A", ordered.positionA),
    ...renderPosition("B", ordered.positionB),
    ...sharedGroundLines(ordered),
    ...timelineLines(ordered, now),
    ...completenessNotes(ordered),
  ].join("\n");
};
