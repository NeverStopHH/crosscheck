/**
 * Constants for the /ui web surface (DESIGN.md §2.1 v0.5: feed, member list,
 * click-to-approve). The UI is HUB functionality — served by packages/server
 * under the FSL license, same trust boundary as the API it renders.
 */
import { MAX_CLAIM_BODY_LENGTH } from "@crosscheck/schema";

export const UI_SESSION_COOKIE_NAME = "crosscheck_ui_session";

/**
 * Bounded session lifetime (task item 2): long enough for a working day,
 * short enough that a stolen cookie dies on its own.
 */
export const UI_SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * Strict CSP on every /ui response (task item 1): no scripts at all
 * (default-src 'none' and no script-src), styles only from this origin
 * (the /ui/styles.css route — nothing inline, nothing external), forms only
 * back to this origin, and no framing. The pages carry zero JS, so nothing
 * needs a nonce.
 */
export const UI_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self'; " +
  "form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** The stylesheet is static and secret-free; pages themselves are no-store. */
export const UI_STYLES_CACHE_CONTROL = "public, max-age=3600";

/** Feed page size — well inside EVENTS_MAX_LIMIT, one screen of activity. */
export const UI_FEED_LIMIT = 50;

/**
 * Live-ish updates via meta refresh (task item 3): one full-page request per
 * viewer per interval, bounded and JS-free — chosen over SSE because SSE
 * needs script, and the whole surface works with JS disabled.
 */
export const UI_FEED_REFRESH_SECONDS = 60;

/** Upper bound on members listed; a hub is a team, not a directory. */
export const UI_MAX_MEMBERS = 200;

/** Read bound on active sessions joined into the member list. */
export const UI_MAX_PRESENCE_ROWS = 500;

/** Upper bound on artifacts listed per page (approvals, work-context). */
export const UI_MAX_ARTIFACTS = 100;

/** Render caps for untrusted text (task item 4) — escaping is the defense,
 * capping keeps one hostile record from swallowing the page. */
export const UI_MAX_TITLE_CHARS = 160;
export const UI_MAX_LABEL_CHARS = 80;
export const UI_MAX_BODY_CHARS = MAX_CLAIM_BODY_LENGTH;
export const UI_MAX_NOTE_CHARS = 400;
export const UI_MAX_ARTIFACT_CHARS = 4000;

/**
 * Longest accepted login form key — real keys are 64 hex chars, so this
 * bound rejects garbage without ever refusing a genuine key:
 *
 * VERIFY: bun -e 'const k=await import("./packages/server/src/auth/keys.ts");const c=await import("./packages/server/src/ui/constants.ts");const key=k.generateApiKey();console.log(key.length, key.length <= c.UI_MAX_API_KEY_FORM_CHARS)'
 * PRINTS: 64 true
 */
export const UI_MAX_API_KEY_FORM_CHARS = 256;
