/** @jsxImportSource hono/jsx */
/**
 * /ui/work-contexts/:id — the diagnosis tree for humans (task item 4).
 *
 * Every author-supplied string (title, bodies, names, notes, targets,
 * artifact content) is a JSX interpolation — escaped by the renderer — and
 * length-capped (format.ts). Kind, status and provenance render as labels,
 * mirroring the MCP renderer's trust-label discipline: a derived draft must
 * not read like a human-vouched claim on this surface either.
 */
import type { FC } from "hono/jsx";

import {
  UI_MAX_ARTIFACT_CHARS,
  UI_MAX_BODY_CHARS,
  UI_MAX_INTENT_CHARS,
  UI_MAX_LABEL_CHARS,
  UI_MAX_NOTE_CHARS,
  UI_MAX_TITLE_CHARS,
} from "../constants.ts";
import { capped, contradictionHref, formatUiAge, uiIntentOf } from "../format.ts";
import { Layout } from "../layout.tsx";
import type { ViewerChrome } from "../layout.tsx";
import type { ArtifactView } from "../../services/artifacts.ts";
import type {
  ClaimEdgeView,
  ClaimView,
  Diagnosis,
} from "../../services/diagnosis.ts";

const CONFIDENCE_DECIMALS = 2;

const ClaimCard: FC<{ readonly claim: ClaimView; readonly nowMs: number }> = ({
  claim,
  nowMs,
}) => (
  <li class="entry">
    <span class="meta">{capped(claim.id, UI_MAX_LABEL_CHARS)}</span>{" "}
    <span class="label">{capped(claim.kind, UI_MAX_LABEL_CHARS)}</span>{" "}
    <span class={`label status-${claim.status}`}>
      {capped(claim.status, UI_MAX_LABEL_CHARS)}
    </span>{" "}
    <span class="label">
      confidence {claim.confidence.toFixed(CONFIDENCE_DECIMALS)}
    </span>{" "}
    <span class={`label provenance-${claim.provenance}`}>
      {capped(claim.provenance, UI_MAX_LABEL_CHARS)}
    </span>{" "}
    <strong>{capped(claim.authorDeveloperName, UI_MAX_LABEL_CHARS)}</strong>{" "}
    <span class="meta">
      {formatUiAge(Math.max(0, nowMs - Date.parse(claim.createdAt)))}
      {claim.dedupCount > 1 ? ` · seen ${String(claim.dedupCount)}×` : ""}
    </span>
    <blockquote class="body">{capped(claim.body, UI_MAX_BODY_CHARS)}</blockquote>
    {claim.evidenceRefs.length === 0 ? null : (
      <p class="meta">
        evidence:{" "}
        {claim.evidenceRefs
          .map((ref) => capped(ref, UI_MAX_LABEL_CHARS))
          .join(", ")}
      </p>
    )}
  </li>
);

const EdgeLine: FC<{ readonly edge: ClaimEdgeView }> = ({ edge }) => (
  <li class="entry">
    <span class="meta">{capped(edge.fromClaimId, UI_MAX_LABEL_CHARS)}</span>{" "}
    <span class="label">{capped(edge.kind, UI_MAX_LABEL_CHARS)}</span>{" "}
    <span class="meta">{capped(edge.toClaimId, UI_MAX_LABEL_CHARS)}</span>
    {edge.note === null ? null : (
      <blockquote class="body">{capped(edge.note, UI_MAX_NOTE_CHARS)}</blockquote>
    )}
  </li>
);

const ArtifactCard: FC<{ readonly artifact: ArtifactView }> = ({ artifact }) => (
  <li class="artifact">
    <span class="label">{capped(artifact.kind, UI_MAX_LABEL_CHARS)}</span>{" "}
    <strong>{capped(artifact.ownerName, UI_MAX_LABEL_CHARS)}</strong>{" "}
    {artifact.sensitivity === "needs_approval" && !artifact.isApproved ? (
      <span class="label">awaiting approval — visible only to you</span>
    ) : null}
    <pre class="artifact-content">
      {capped(artifact.content, UI_MAX_ARTIFACT_CHARS)}
    </pre>
  </li>
);

interface WorkContextPageProps {
  readonly viewer: ViewerChrome;
  readonly diagnosis: Diagnosis;
  readonly ownerName: string | null;
  /** Epoch ms of the solving claim (services/solved.ts), or null = open. */
  readonly solvedAtMs: number | null;
  readonly artifacts: readonly ArtifactView[];
  /** Deterministic pair ids of live contradictions touching this tree. */
  readonly contradictionIds: readonly string[];
  readonly nowMs: number;
}

export const WorkContextPage: FC<WorkContextPageProps> = ({
  viewer,
  diagnosis,
  ownerName,
  solvedAtMs,
  artifacts,
  contradictionIds,
  nowMs,
}) => {
  const context = diagnosis.workContext;
  const intent = uiIntentOf(context.intent);
  return (
    <Layout title="Work context" viewer={viewer}>
      <h1>{capped(context.title, UI_MAX_TITLE_CHARS)}</h1>
      {intent === null ? null : (
        <p class="intent">
          <span class="label">{intent.label}</span>{" "}
          {capped(intent.summary, UI_MAX_INTENT_CHARS)}
        </p>
      )}
      <p class="meta">
        <span class="label">{capped(context.status, UI_MAX_LABEL_CHARS)}</span>{" "}
        {solvedAtMs === null ? null : (
          <span class="label solved">
            solved · {formatUiAge(Math.max(0, nowMs - solvedAtMs))}
          </span>
        )}{" "}
        {context.landedAt === null ? null : (
          <span class="label landed">landed on the default branch</span>
        )}{" "}
        {ownerName === null ? null : (
          <>opened by {capped(ownerName, UI_MAX_LABEL_CHARS)} · </>
        )}
        {formatUiAge(Math.max(0, nowMs - Date.parse(context.createdAt)))}
      </p>
      {contradictionIds.length === 0 ? null : (
        <div class="card">
          <strong>Open contradiction</strong> — two theories about this work
          cannot both be right:{" "}
          {contradictionIds.map((id) => (
            <a href={contradictionHref(id)}>referee case file</a>
          ))}
        </div>
      )}
      {diagnosis.truncated ? (
        <p class="notice">
          The hub truncated this tree at its own bound — what follows is
          partial.
        </p>
      ) : null}

      <h2>Claims ({String(diagnosis.claims.length)})</h2>
      {diagnosis.claims.length === 0 ? (
        <p class="notice">No claims recorded yet.</p>
      ) : (
        <ul class="plain">
          {diagnosis.claims.map((claim) => (
            <ClaimCard claim={claim} nowMs={nowMs} />
          ))}
        </ul>
      )}

      {diagnosis.edges.length === 0 ? null : (
        <>
          <h2>Edges ({String(diagnosis.edges.length)})</h2>
          <ul class="plain">
            {diagnosis.edges.map((edge) => (
              <EdgeLine edge={edge} />
            ))}
          </ul>
        </>
      )}

      {diagnosis.targets.length === 0 ? null : (
        <>
          <h2>Targets</h2>
          <p class="meta">
            {diagnosis.targets
              .map(
                (target) =>
                  `${capped(target.kind, UI_MAX_LABEL_CHARS)}: ${capped(target.value, UI_MAX_LABEL_CHARS)}`,
              )
              .join(" · ")}
          </p>
        </>
      )}

      {artifacts.length === 0 ? null : (
        <>
          <h2>Artifacts ({String(artifacts.length)})</h2>
          <ul class="plain">
            {artifacts.map((artifact) => (
              <ArtifactCard artifact={artifact} />
            ))}
          </ul>
        </>
      )}
    </Layout>
  );
};
