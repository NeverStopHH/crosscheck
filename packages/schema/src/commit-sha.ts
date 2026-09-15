/**
 * The one alphabet a commit hash may have on the wire or on a git command
 * line: nothing flag- or prose-shaped ever reaches git or SQL.
 *
 * ONE COPY, and the comment it replaces said why two would be wrong. This
 * pattern had two independent definitions — `git/commit-drift.ts` in the
 * connector (whose own comment warned that "two copies would be two things to
 * widen") and a private one here in `landed-evidence.ts`. Claim binding needed
 * a third, on a wire schema the connector also reads, so it is hoisted instead:
 * `@crosscheck/schema` is the package both halves already depend on.
 *
 * Abbreviated hashes are legal — 7 is git's own historical minimum and what
 * `rev-parse --short` prints — because the values that travel are what a
 * renderer shows and what `rev-list` is handed back, never a key.
 */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;
