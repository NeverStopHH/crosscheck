/** @jsxImportSource hono/jsx */
/**
 * /ui/approvals — the OWNER's queue of needs_approval artifacts (task
 * item 6). Only rows the hub already scoped to the signed-in owner arrive
 * here (services/artifacts.ts listOwnedNeedsApproval); each row carries a
 * plain POST form — approve or revoke — with the session-bound CSRF token.
 * Content previews are escaped by the renderer and length-capped.
 */
import type { FC } from "hono/jsx";

import {
  UI_MAX_ARTIFACT_CHARS,
  UI_MAX_LABEL_CHARS,
} from "../constants.ts";
import { capped, formatUiAge, workContextHref } from "../format.ts";
import { Layout } from "../layout.tsx";
import type { ViewerChrome } from "../layout.tsx";
import type { ArtifactView } from "../../services/artifacts.ts";

const artifactActionPath = (artifactId: string, action: string): string =>
  `/ui/artifacts/${encodeURIComponent(artifactId)}/${action}`;

const ApprovalRow: FC<{
  readonly artifact: ArtifactView;
  readonly csrfToken: string;
  readonly nowMs: number;
}> = ({ artifact, csrfToken, nowMs }) => (
  <li class="artifact">
    <span class="label">{capped(artifact.kind, UI_MAX_LABEL_CHARS)}</span>{" "}
    <span class="meta">{capped(artifact.id, UI_MAX_LABEL_CHARS)}</span> · in{" "}
    <a href={workContextHref(artifact.workContextId)}>
      {capped(artifact.workContextId, UI_MAX_LABEL_CHARS)}
    </a>{" "}
    ·{" "}
    <span class="meta">
      {formatUiAge(Math.max(0, nowMs - Date.parse(artifact.createdAt)))}
    </span>{" "}
    {artifact.isApproved ? (
      <span class="label">approved — team can see it</span>
    ) : (
      <span class="label">awaiting your approval</span>
    )}
    <pre class="artifact-content">
      {capped(artifact.content, UI_MAX_ARTIFACT_CHARS)}
    </pre>
    {artifact.isApproved ? (
      <form
        class="inline"
        method="post"
        action={artifactActionPath(artifact.id, "revoke")}
      >
        <input type="hidden" name="_csrf" value={csrfToken} />
        <button type="submit" class="revoke">
          Revoke
        </button>
      </form>
    ) : (
      <form
        class="inline"
        method="post"
        action={artifactActionPath(artifact.id, "approve")}
      >
        <input type="hidden" name="_csrf" value={csrfToken} />
        <button type="submit" class="approve">
          Approve for the team
        </button>
      </form>
    )}
  </li>
);

interface ApprovalsPageProps {
  readonly viewer: ViewerChrome;
  readonly artifacts: readonly ArtifactView[];
  readonly nowMs: number;
}

export const ApprovalsPage: FC<ApprovalsPageProps> = ({
  viewer,
  artifacts,
  nowMs,
}) => (
  <Layout title="Approvals" viewer={viewer}>
    <h1>Approvals</h1>
    <p class="notice">
      Artifacts you shared default to needs-approval: only you can see their
      content until you approve them here. Revoking hides the content from
      the team again.
    </p>
    {artifacts.length === 0 ? (
      <p class="notice">Nothing awaiting your decision.</p>
    ) : (
      <ul class="plain">
        {artifacts.map((artifact) => (
          <ApprovalRow
            artifact={artifact}
            csrfToken={viewer.csrfToken}
            nowMs={nowMs}
          />
        ))}
      </ul>
    )}
  </Layout>
);
