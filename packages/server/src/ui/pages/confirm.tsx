/** @jsxImportSource hono/jsx */
/**
 * /ui/confirm — where a person makes their own judgements theirs (human
 * provenance §6). Every pending draft is listed with its context and who
 * drafted it; each takes a decision (confirm, discard, leave for later), and
 * labels and outcomes may be edited. One passkey assertion signs a digest of
 * exactly the batch the page froze — and a draft that arrives after the page
 * loaded refuses the batch, so the person reviews again.
 *
 * Titles, names, words and reasons are author-written text: escaped, capped
 * JSX interpolations, never markup, with every bidi, control and format
 * character shown as its code point (round-1 review L4: `shownAsSigned`).
 */
import type { FC } from "hono/jsx";
import { HINT_OUTCOMES, MAX_PILOT_LABEL_REASON_CHARS, PILOT_INTERVENTION_LABELS } from "@crosscheck/schema";
import type { DraftKind, DraftProvenance } from "@crosscheck/schema";

import { UI_MAX_LABEL_CHARS, UI_MAX_NOTE_CHARS, UI_MAX_TITLE_CHARS } from "../constants.ts";
import { shownAsSigned } from "../format.ts";
import { Layout } from "../layout.tsx";
import type { ViewerChrome } from "../layout.tsx";
import type { DraftContext } from "../../services/confirm-page.ts";
import { CeremonyChrome, NoOriginNotice } from "./ceremony-chrome.tsx";

/** Who drafted it, said so a person never mistakes it for their own proven word. */
export const PROVENANCE_LABEL: Readonly<Record<DraftProvenance, string>> = {
  agent_asserted: "drafted by your agent",
  interactive_terminal_asserted: "typed at a terminal — not proven to be you",
};

const KIND_LABEL: Readonly<Record<DraftKind, string>> = {
  label: "your label on a hint",
  pin_ok: "a pin still works",
  outcome: "what a hint led to",
  pin: "a new pin",
  pin_broke: "a pin is broken",
  mute: "mute a teammate",
  unmute: "unmute a teammate",
  presence_on: "show your presence to teammates again",
};

const text = (draft: DraftContext, key: string): string => String(draft.payload[key] ?? "");

const WordChoice: FC<{ readonly draft: DraftContext }> = ({ draft }) => {
  const words = draft.kind === "label" ? PILOT_INTERVENTION_LABELS : HINT_OUTCOMES;
  const current = text(draft, "word");
  return (
    <>
      <label>
        Word{" "}
        <select name="word">
          {words.map((word) => (
            <option value={word} selected={word === current}>
              {word}
            </option>
          ))}
        </select>
      </label>{" "}
      <label>
        Reason{" "}
        <input name="reason" maxlength={MAX_PILOT_LABEL_REASON_CHARS} value={text(draft, "reason")} />
      </label>
    </>
  );
};

const Subject: FC<{ readonly draft: DraftContext }> = ({ draft }) => {
  if (draft.kind === "label" || draft.kind === "outcome") {
    return (
      <span class="meta">
        a {shownAsSigned(draft.channel ?? "hint", UI_MAX_LABEL_CHARS)}
        {draft.deliveredAt === null ? "" : ` delivered ${draft.deliveredAt}`} · pointed at{" "}
        {draft.pointedTitle === null ? "work not on this repo's record" : `«${shownAsSigned(draft.pointedTitle, UI_MAX_TITLE_CHARS)}»`}
        {draft.sourceName === null ? "" : ` by ${shownAsSigned(draft.sourceName, UI_MAX_LABEL_CHARS)}`} · said:{" "}
        {shownAsSigned(text(draft, "word"), UI_MAX_LABEL_CHARS)}
      </span>
    );
  }
  if (draft.kind === "pin" || draft.kind === "pin_broke" || draft.kind === "pin_ok") {
    const files = draft.payload["files"];
    return (
      <span class="meta">
        pin {shownAsSigned(text(draft, "pinId") || text(draft, "id"), UI_MAX_LABEL_CHARS)} «
        {shownAsSigned(draft.pinSurface ?? "", UI_MAX_TITLE_CHARS)}»
        {Array.isArray(files) ? ` · ${String(files.length)} file(s), every one listed below` : ""}
      </span>
    );
  }
  if (draft.kind === "mute" || draft.kind === "unmute") {
    return <span class="meta">{shownAsSigned(text(draft, "name"), UI_MAX_LABEL_CHARS)}</span>;
  }
  return null;
};

/** A signed value is never cut (review M2): only its acting characters are shown as code points. */
const WHOLE = Number.POSITIVE_INFINITY;

/** One signed value, in full: a list as every item, scrollable; nothing cut (review M2). */
const TermValue: FC<{ readonly value: unknown }> = ({ value }) => {
  if (Array.isArray(value)) {
    return (
      <ol class="signed-list">
        {value.map((item) => (
          <li>{shownAsSigned(String(item), WHOLE)}</li>
        ))}
      </ol>
    );
  }
  if (value === null || value === undefined) {
    return <>—</>;
  }
  return <>{shownAsSigned(typeof value === "object" ? JSON.stringify(value) : String(value), WHOLE)}</>;
};

/**
 * EVERYTHING THE SIGNATURE COVERS (§6; review M2): the digest is over the
 * draft's id, version, subject and WHOLE payload, and this page is the only
 * place a person sees those terms (R6) — so every one is listed, uncut: a
 * pin's check recipe, its commit, every file. Escaped like every other text.
 */
const SignedTerms: FC<{ readonly draft: DraftContext }> = ({ draft }) => (
  <details class="signed-terms" open>
    <summary>exactly what your passkey signs for this one</summary>
    <dl>
      <dt>draft</dt>
      <dd>
        {draft.id} · version {String(draft.version)}
      </dd>
      <dt>about</dt>
      <dd>{shownAsSigned(draft.subjectKey, WHOLE)}</dd>
      {Object.keys(draft.payload)
        .sort()
        .map((key) => (
          <>
            <dt data-term={key}>{key}</dt>
            <dd>
              <TermValue value={draft.payload[key]} />
            </dd>
          </>
        ))}
    </dl>
  </details>
);

/** Why a decided draft is back (round-2 R2-H3): nothing it said counted, so the person decides again. */
const RECONFIRM_LINE: Readonly<Record<"cooling" | "compromised", string>> = {
  cooling: "re-confirm: the passkey that confirmed these was revoked before it counted",
  compromised: "re-confirm: the passkey that confirmed these was revoked as compromised",
};

const DraftCard: FC<{ readonly draft: DraftContext }> = ({ draft }) => (
  <li class="artifact" data-draft-id={draft.id} data-version={String(draft.version)}>
    <span class="label">{KIND_LABEL[draft.kind]}</span>{" "}
    <span class="meta">
      {PROVENANCE_LABEL[draft.provenance]} · {draft.createdAt}
      {draft.repo === null ? "" : ` · ${shownAsSigned(draft.repo, UI_MAX_LABEL_CHARS)}`}
    </span>{" "}
    <Subject draft={draft} />
    {draft.reconfirm === null ? null : <p class="notice">{RECONFIRM_LINE[draft.reconfirm]}</p>}
    {text(draft, "reason") === "" ? null : <blockquote>{shownAsSigned(text(draft, "reason"), UI_MAX_NOTE_CHARS)}</blockquote>}
    <SignedTerms draft={draft} />
    <div>
      <label>
        Decision{" "}
        <select name="decision">
          <option value="confirm">confirm as mine</option>
          <option value="discard">discard</option>
          <option value="keep" selected>
            leave for later
          </option>
        </select>
      </label>{" "}
      {draft.kind === "label" || draft.kind === "outcome" ? <WordChoice draft={draft} /> : null}
    </div>
  </li>
);

export interface ConfirmPageProps {
  readonly viewer: ViewerChrome;
  readonly fingerprint: string;
  readonly drafts: readonly DraftContext[];
  readonly hasOrigin: boolean;
  readonly hasConfirmingPasskey: boolean;
  /** Presence switched off by the key within the notice window — immediate, and told here. */
  readonly keyedOptOutAt: string | null;
}

export const ConfirmPage: FC<ConfirmPageProps> = ({
  viewer,
  fingerprint,
  drafts,
  hasOrigin,
  hasConfirmingPasskey,
  keyedOptOutAt,
}) => (
  <Layout title="Confirm" viewer={viewer}>
    <h1>Confirm what is yours</h1>
    <p class="notice">
      Your agent and your terminal can only draft. Nothing below counts as your judgement, protects
      anything or changes a setting until you confirm it here with your passkey. One touch signs
      exactly the decisions on this page; a draft that arrives after the page loaded is not in it.
    </p>
    {keyedOptOutAt === null ? null : (
      <p class="notice">
        Your presence was switched off at {keyedOptOutAt} by something holding your key. That took
        effect at once, because going more private never waits. If it was not you, switch it back on.
      </p>
    )}
    {!hasOrigin ? <NoOriginNotice /> : null}
    {hasOrigin && !hasConfirmingPasskey ? (
      <p class="notice">
        You have no passkey that can confirm at this address. Enrol one at <a href="/ui/passkeys">Passkeys</a>; it
        can confirm your own drafts at once.
      </p>
    ) : null}
    {drafts.length === 0 ? (
      <p>Nothing waits for you.</p>
    ) : (
      <form data-confirm-batch="confirm">
        <input type="hidden" name="fingerprint" value={fingerprint} />
        <ul class="artifacts">{drafts.map((draft) => <DraftCard draft={draft} />)}</ul>
        <output></output>{" "}
        <button type="submit" class="approve">
          Sign these decisions with my passkey
        </button>
      </form>
    )}
    {hasOrigin ? <CeremonyChrome csrfToken={viewer.csrfToken} /> : null}
  </Layout>
);
