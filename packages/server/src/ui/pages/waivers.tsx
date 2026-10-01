/** @jsxImportSource hono/jsx */
/**
 * /ui/waivers — where a person answers an agent's request to open a
 * human-verified fence, and amends or closes the fences already open
 * (1.0 spec 04a §6). Every action is a passkey ceremony over exactly the
 * terms in its form; the form's `<output>` shows the expiry it will sign.
 *
 * Reasons, surfaces and names are author-written text: escaped, capped JSX
 * interpolations, never markup. A `terminal` waiver says it was opened the
 * pre-04a way, with the weaker authority any agent holding the key had.
 */
import type { FC } from "hono/jsx";
import { MAX_WAIVER_REASON_CHARS } from "@crosscheck/schema";

import { UI_MAX_LABEL_CHARS, UI_MAX_NOTE_CHARS } from "../constants.ts";
import { capped } from "../format.ts";
import { Layout } from "../layout.tsx";
import type { ViewerChrome } from "../layout.tsx";
import type { WaiverRequestView } from "../../services/waiver-requests.ts";
import type { OpenFence } from "../../services/waivers.ts";
import { CeremonyChrome, NoOriginNotice } from "./ceremony-chrome.tsx";

/** What a pre-04a grant is called wherever it is shown (PK-11). */
export const TERMINAL_AUTHORITY_LABEL =
  "opened from a terminal before passkeys (weaker authority)";

const RequestCard: FC<{ readonly request: WaiverRequestView }> = ({ request }) => (
  <li class="artifact">
    <span class="label">{capped(request.surface, UI_MAX_LABEL_CHARS)}</span>{" "}
    <span class="meta">
      pin {capped(request.pinId, UI_MAX_LABEL_CHARS)} · {capped(request.repo, UI_MAX_LABEL_CHARS)} · version{" "}
      {String(request.pinVersion)} · asked by{" "}
      {capped(request.requestedByName, UI_MAX_LABEL_CHARS)} until {request.expiresAt}
    </span>
    <blockquote>{capped(request.reason, UI_MAX_NOTE_CHARS)}</blockquote>
    <form data-ceremony="approve">
      <input type="hidden" name="action" value="approve" />
      <input type="hidden" name="subjectId" value={request.id} />
      <input type="hidden" name="requestedExpiresAt" value={request.expiresAt} />
      <label>
        Shorten to hours from now (optional){" "}
        <input name="hours" type="number" min="1" step="1" />
      </label>{" "}
      <label>
        Reason on the record{" "}
        <input name="reason" required maxlength={MAX_WAIVER_REASON_CHARS} value={request.reason} />
      </label>{" "}
      <output></output>{" "}
      <button type="submit" class="approve">Approve with passkey</button>
    </form>
  </li>
);

const FenceCard: FC<{ readonly fence: OpenFence }> = ({ fence }) => (
  <li class="artifact">
    <span class="label">{capped(fence.surface, UI_MAX_LABEL_CHARS)}</span>{" "}
    <span class="meta">
      pin {capped(fence.pinId, UI_MAX_LABEL_CHARS)} · {capped(fence.repo, UI_MAX_LABEL_CHARS)} · open until{" "}
      {fence.expiresAt} · by{" "}
      {capped(fence.grantedByName, UI_MAX_LABEL_CHARS)}
    </span>{" "}
    {fence.authority === "terminal" ? <span class="label">{TERMINAL_AUTHORITY_LABEL}</span> : null}
    <blockquote>{capped(fence.reason, UI_MAX_NOTE_CHARS)}</blockquote>
    <form data-ceremony="amend">
      <input type="hidden" name="action" value="amend" />
      <input type="hidden" name="subjectId" value={fence.id} />
      <label>
        New expiry, hours from now <input name="hours" type="number" min="1" step="1" required />
      </label>{" "}
      <label>
        Reason <input name="reason" required maxlength={MAX_WAIVER_REASON_CHARS} />
      </label>{" "}
      <output></output>{" "}
      <button type="submit">Amend with passkey</button>
    </form>
    <form data-ceremony="revoke_waiver">
      <input type="hidden" name="action" value="revoke_waiver" />
      <input type="hidden" name="subjectId" value={fence.id} />
      <label>
        Reason <input name="reason" required maxlength={MAX_WAIVER_REASON_CHARS} />
      </label>{" "}
      <button type="submit" class="revoke">Close the fence with passkey</button>
    </form>
  </li>
);

interface WaiversPageProps {
  readonly viewer: ViewerChrome;
  readonly requests: readonly WaiverRequestView[];
  readonly fences: readonly OpenFence[];
  readonly hasOrigin: boolean;
  readonly hasUsablePasskey: boolean;
}

export const WaiversPage: FC<WaiversPageProps> = ({
  viewer,
  requests,
  fences,
  hasOrigin,
  hasUsablePasskey,
}) => (
  <Layout title="Waivers" viewer={viewer}>
    <h1>Waivers</h1>
    <p class="notice">
      An agent can ask for a human-verified fence to open; only a person with
      a passkey can say yes. Read what you sign: the expiry and reason below
      are exactly what is stored.
    </p>
    {!hasOrigin ? <NoOriginNotice /> : null}
    {hasOrigin && !hasUsablePasskey ? (
      <p class="notice">
        You have no passkey that can approve yet. Enrol one at <a href="/ui/passkeys">Passkeys</a>;
        it can act a day after enrolment.
      </p>
    ) : null}
    <h2>Waiting for a person</h2>
    {requests.length === 0 ? (
      <p>No open requests.</p>
    ) : (
      <ul class="artifacts">{requests.map((request) => <RequestCard request={request} />)}</ul>
    )}
    <h2>Fences open now</h2>
    {fences.length === 0 ? (
      <p>No fence is open.</p>
    ) : (
      <ul class="artifacts">{fences.map((fence) => <FenceCard fence={fence} />)}</ul>
    )}
    {hasOrigin ? <CeremonyChrome csrfToken={viewer.csrfToken} /> : null}
  </Layout>
);
