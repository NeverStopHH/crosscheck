/** @jsxImportSource hono/jsx */
/**
 * /ui/passkeys — a person's own passkeys (1.0 spec 04a §4): enrol one with
 * the code the admin handed over, add another device by confirming with an
 * existing passkey, and revoke one. Every label is author-written text and
 * reaches the page as an escaped, capped JSX interpolation.
 */
import type { FC } from "hono/jsx";
import { MAX_PASSKEY_LABEL_CHARS } from "@crosscheck/schema";

import { PASSKEY_ANNOUNCEMENT_DAYS } from "../../constants.ts";
import { UI_MAX_LABEL_CHARS } from "../constants.ts";
import { capped } from "../format.ts";
import { Layout } from "../layout.tsx";
import type { ViewerChrome } from "../layout.tsx";
import type { EnrolmentAnnouncement, PasskeyView } from "../../services/passkeys.ts";
import { CeremonyChrome, NoOriginNotice } from "./ceremony-chrome.tsx";

const stateOf = (passkey: PasskeyView): string => {
  if (passkey.revokedAt !== null) {
    return `revoked ${passkey.revokedAt}`;
  }
  return passkey.coolingOff
    ? `cooling off — can approve from ${passkey.usableFrom}`
    : "can approve";
};

const PasskeyRow: FC<{ readonly passkey: PasskeyView; readonly csrfToken: string }> = ({
  passkey,
  csrfToken,
}) => (
  <li class="artifact">
    <span class="label">{capped(passkey.label, UI_MAX_LABEL_CHARS)}</span>{" "}
    <span class="meta">
      {passkey.authenticator} · at {passkey.rpId} · enrolled {passkey.createdAt}
    </span>{" "}
    <span class="label">{stateOf(passkey)}</span>
    {passkey.revokedAt !== null ? null : passkey.coolingOff ? (
      // During the cool-off the api key's session may revoke it: making a
      // credential LESS capable needs no stronger authority (04a §4.4).
      <form class="inline" method="post" action={`/ui/passkeys/${encodeURIComponent(passkey.id)}/revoke`}>
        <input type="hidden" name="_csrf" value={csrfToken} />
        <button type="submit" class="revoke">Revoke — I did not enrol this</button>
      </form>
    ) : (
      <form class="inline" data-ceremony="revoke_passkey">
        <input type="hidden" name="action" value="revoke_passkey" />
        <input type="hidden" name="subjectId" value={passkey.id} />
        <button type="submit" class="revoke">Revoke with a passkey</button>
      </form>
    )}
  </li>
);

const announcedStateOf = (enrolment: EnrolmentAnnouncement): string => {
  if (enrolment.revoked) {
    return "revoked";
  }
  return enrolment.coolingOff
    ? `still cooling off — can approve from ${enrolment.usableFrom}; not expected? tell them or the admin before then`
    : "can approve";
};

/**
 * THE HUB'S OWN ANNOUNCEMENT (04a §4.3), on a page the hub serves. `status`
 * and `doctor` say the same, but they run beside the agent and read a hub URL
 * the agent can rewrite; this list reaches the person's browser from the hub.
 */
const RecentEnrolments: FC<{
  readonly recent: readonly EnrolmentAnnouncement[];
  readonly total: number;
}> = ({ recent, total }) => (
  <div class="card">
    <h2>Enrolled on this hub in the last {String(PASSKEY_ANNOUNCEMENT_DAYS)} days</h2>
    {recent.length === 0 ? (
      <p>No passkey was enrolled on this hub in that time.</p>
    ) : (
      <ul class="artifacts">
        {recent.map((enrolment) => (
          <li class="artifact">
            <span class="label">{capped(enrolment.developerName, UI_MAX_LABEL_CHARS)}</span>{" "}
            <span class="meta">
              {capped(enrolment.label, UI_MAX_LABEL_CHARS)} · {enrolment.authenticator} · enrolled{" "}
              {enrolment.createdAt}
            </span>{" "}
            <span class="label">{announcedStateOf(enrolment)}</span>
          </li>
        ))}
      </ul>
    )}
    {total > recent.length ? <p>And {String(total - recent.length)} more not listed here.</p> : null}
  </div>
);

interface PasskeysPageProps {
  readonly viewer: ViewerChrome;
  readonly passkeys: readonly PasskeyView[];
  readonly hasOrigin: boolean;
  readonly canAuthoriseAnother: boolean;
  readonly recent: readonly EnrolmentAnnouncement[];
  readonly recentTotal: number;
}

export const PasskeysPage: FC<PasskeysPageProps> = ({
  viewer,
  passkeys,
  hasOrigin,
  canAuthoriseAnother,
  recent,
  recentTotal,
}) => (
  <Layout title="Passkeys" viewer={viewer}>
    <h1>Passkeys</h1>
    <p class="notice">
      A passkey is the one credential an agent on your machine cannot use: it
      lives behind your device's fingerprint, face or PIN. Opening or closing
      a human-verified fence needs one. A new passkey is announced to the team
      and can act only after a day, so one you did not enrol is seen before it
      can do anything.
    </p>
    {!hasOrigin ? (
      <NoOriginNotice />
    ) : (
      <>
        {passkeys.length === 0 ? (
          <p>No passkeys yet.</p>
        ) : (
          <ul class="artifacts">
            {passkeys.map((passkey) => (
              <PasskeyRow passkey={passkey} csrfToken={viewer.csrfToken} />
            ))}
          </ul>
        )}
        <div class="card">
          <h2>Enrol this device</h2>
          <form data-ceremony="enrol">
            <input type="hidden" name="action" value="enrol" />
            <label>
              Enrolment code from the admin{" "}
              <input name="code" required autocomplete="off" />
            </label>{" "}
            <label>
              Name for this device{" "}
              <input name="label" required maxlength={MAX_PASSKEY_LABEL_CHARS} />
            </label>{" "}
            <button type="submit">Enrol passkey</button>
          </form>
        </div>
        {canAuthoriseAnother ? (
          <div class="card">
            <h2>Add another device</h2>
            <form data-ceremony="authorise_enrolment">
              <input type="hidden" name="action" value="authorise_enrolment" />
              <button type="submit">Confirm with an existing passkey</button>
            </form>
          </div>
        ) : null}
        <CeremonyChrome csrfToken={viewer.csrfToken} />
      </>
    )}
    <RecentEnrolments recent={recent} total={recentTotal} />
  </Layout>
);
