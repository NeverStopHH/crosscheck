/** @jsxImportSource hono/jsx */
/**
 * /ui/contradictions/:id — the referee case file for humans: two positions
 * that cannot both be right, each with its evidence, ruled-out approaches
 * and author. Same escaping + capping discipline as the work-context page.
 */
import type { FC } from "hono/jsx";

import {
  UI_MAX_BODY_CHARS,
  UI_MAX_LABEL_CHARS,
  UI_MAX_TITLE_CHARS,
} from "../constants.ts";
import { capped, workContextHref } from "../format.ts";
import { Layout } from "../layout.tsx";
import type { ViewerChrome } from "../layout.tsx";
import type {
  RefereeBriefView,
  RefereeClaimView,
  RefereePositionView,
} from "../../services/referee.ts";

const CONFIDENCE_DECIMALS = 2;

const ClaimQuote: FC<{ readonly claim: RefereeClaimView }> = ({ claim }) => (
  <li class="entry">
    <span class="label">{capped(claim.kind, UI_MAX_LABEL_CHARS)}</span>{" "}
    <span class={`label status-${claim.status}`}>
      {capped(claim.status, UI_MAX_LABEL_CHARS)}
    </span>{" "}
    <span class={`label provenance-${claim.provenance}`}>
      {capped(claim.provenance, UI_MAX_LABEL_CHARS)}
    </span>{" "}
    <strong>{capped(claim.authorDeveloperName, UI_MAX_LABEL_CHARS)}</strong>
    <blockquote class="body">{capped(claim.body, UI_MAX_BODY_CHARS)}</blockquote>
  </li>
);

const Position: FC<{
  readonly heading: string;
  readonly position: RefereePositionView;
}> = ({ heading, position }) => (
  <div class="card">
    <h2>{heading}</h2>
    <p class="meta">
      in{" "}
      <a href={workContextHref(position.claim.workContextId)}>
        {capped(position.workContextTitle, UI_MAX_TITLE_CHARS)}
      </a>{" "}
      · confidence {position.claim.confidence.toFixed(CONFIDENCE_DECIMALS)}
      {position.supersededByClaimId === null
        ? ""
        : " · superseded by its own author"}
    </p>
    <ul class="plain">
      <ClaimQuote claim={position.claim} />
    </ul>
    {position.evidence.length === 0 ? (
      <p class="notice">No evidence recorded for this position.</p>
    ) : (
      <>
        <h3>Evidence</h3>
        <ul class="plain">
          {position.evidence.map((claim) => (
            <ClaimQuote claim={claim} />
          ))}
        </ul>
        {position.evidenceTruncated ? (
          <p class="notice">Evidence list truncated at the hub's bound.</p>
        ) : null}
      </>
    )}
    {position.ruledOut.length === 0 ? null : (
      <>
        <h3>Ruled out on this side</h3>
        <ul class="plain">
          {position.ruledOut.map((claim) => (
            <ClaimQuote claim={claim} />
          ))}
        </ul>
      </>
    )}
  </div>
);

interface RefereePageProps {
  readonly viewer: ViewerChrome;
  readonly brief: RefereeBriefView;
}

export const RefereePage: FC<RefereePageProps> = ({ viewer, brief }) => (
  <Layout title="Referee case file" viewer={viewer}>
    <h1>Referee case file</h1>
    <p class="meta">
      {brief.reason === "similarity"
        ? "Flagged by similarity between the two claims."
        : "Flagged deterministically: shared target, opposite status."}
    </p>
    <Position heading="Position A" position={brief.positionA} />
    <Position heading="Position B" position={brief.positionB} />
    {brief.sharedTargets.length === 0 ? null : (
      <p class="meta">
        Shared targets:{" "}
        {brief.sharedTargets
          .map(
            (target) =>
              `${capped(target.kind, UI_MAX_LABEL_CHARS)}: ${capped(target.value, UI_MAX_LABEL_CHARS)}`,
          )
          .join(" · ")}
      </p>
    )}
  </Layout>
);
