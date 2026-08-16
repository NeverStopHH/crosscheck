/**
 * Presentation helpers for the /ui pages. Escaping is NOT done here — the
 * hono/jsx renderer escapes every interpolated string by construction — this
 * file only caps lengths (task item 4, mirroring the MCP renderer's cap
 * discipline) and words ages.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Human age, coarse on purpose — the feed is a timeline, not a stopwatch. */
export const formatUiAge = (ageMs: number): string => {
  if (ageMs < MS_PER_MINUTE) {
    return "just now";
  }
  if (ageMs < MS_PER_HOUR) {
    return `${String(Math.floor(ageMs / MS_PER_MINUTE))}m ago`;
  }
  if (ageMs < MS_PER_DAY) {
    return `${String(Math.floor(ageMs / MS_PER_HOUR))}h ago`;
  }
  return `${String(Math.floor(ageMs / MS_PER_DAY))}d ago`;
};

const ELLIPSIS = "…";

/**
 * Length cap for untrusted text. The JSX renderer escapes what remains; the
 * cap only stops one hostile record from swallowing the page. Slicing a
 * surrogate pair in half is harmless here — the escaper still escapes it.
 */
export const capped = (value: string, maxChars: number): string =>
  value.length <= maxChars ? value : `${value.slice(0, maxChars)}${ELLIPSIS}`;

/** href for a work-context page; the id is percent-encoded, never trusted. */
export const workContextHref = (workContextId: string): string =>
  `/ui/work-contexts/${encodeURIComponent(workContextId)}`;

/** href for a referee case-file page. */
export const contradictionHref = (contradictionId: string): string =>
  `/ui/contradictions/${encodeURIComponent(contradictionId)}`;
