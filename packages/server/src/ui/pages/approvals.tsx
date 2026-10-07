/** @jsxImportSource hono/jsx */
/**
 * /ui/approvals — the OWNER's queue of needs_approval artifacts (task
 * item 6). Only rows the hub already scoped to the signed-in owner arrive
 * here (services/artifacts.ts listOwnedNeedsApproval). Content previews are
 * escaped by the renderer and length-capped.
 *
 * RELEASE IS A PASSKEY CEREMONY (review M2). Each row's button is a
 * `data-ceremony` form the passkey script runs (ui/passkey-script.ts), like
 * the ones on /ui/waivers: an API key opens a session here, and so does any
 * agent that holds it, so the session alone releases nothing. A hub with no
 * passkey origin shows the notice /ui/waivers shows, and no ceremony.
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
import { CeremonyChrome, NoOriginNotice } from "./ceremony-chrome.tsx";

const ReleaseForm: FC<{
  readonly artifactId: string;
  readonly action: "approve_artifact" | "revoke_artifact";
}> = ({ artifactId, action }) => (
  <form class="inline" data-ceremony={action}>
    <input type="hidden" name="action" value={action} />
    <input type="hidden" name="subjectId" value={artifactId} />
    {action === "approve_artifact" ? (
      <button type="submit" class="approve">
        Approve for the team with passkey
      </button>
    ) : (
      <button type="submit" class="revoke">
        Revoke with passkey
      </button>
    )}
  </form>
);

const ApprovalRow: FC<{
  readonly artifact: ArtifactView;
  readonly nowMs: number;
}> = ({ artifact, nowMs }) => (
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
    <ReleaseForm
      artifactId={artifact.id}
      action={artifact.isApproved ? "revoke_artifact" : "approve_artifact"}
    />
  </li>
);

interface ApprovalsPageProps {
  readonly viewer: ViewerChrome;
  readonly artifacts: readonly ArtifactView[];
  readonly nowMs: number;
  readonly hasOrigin: boolean;
  readonly hasUsablePasskey: boolean;
}

export const ApprovalsPage: FC<ApprovalsPageProps> = ({
  viewer,
  artifacts,
  nowMs,
  hasOrigin,
  hasUsablePasskey,
}) => (
  <Layout title="Approvals" viewer={viewer}>
    <h1>Approvals</h1>
    <p class="notice">
      Artifacts you shared default to needs-approval: only you can see their
      content until you approve them here, with your passkey. Revoking hides
      the content from the team again, and takes the passkey too.
    </p>
    {!hasOrigin ? <NoOriginNotice /> : null}
    {hasOrigin && !hasUsablePasskey ? (
      <p class="notice">
        You have no passkey that can approve yet. Enrol one at <a href="/ui/passkeys">Passkeys</a>;
        it can act a day after enrolment.
      </p>
    ) : null}
    {artifacts.length === 0 ? (
      <p class="notice">Nothing awaiting your decision.</p>
    ) : (
      <ul class="plain">
        {artifacts.map((artifact) => (
          <ApprovalRow artifact={artifact} nowMs={nowMs} />
        ))}
      </ul>
    )}
    {hasOrigin ? <CeremonyChrome csrfToken={viewer.csrfToken} /> : null}
  </Layout>
);
