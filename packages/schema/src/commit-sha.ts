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

/**
 * What a connector reports as its base commit when git could not name HEAD at
 * all — an unborn branch, a repository with no commits, a git that did not
 * answer (connector-core git/repo-identity.ts, which re-exports this).
 *
 * It is seven hex characters, so COMMIT_SHA_PATTERN alone accepts it. That is
 * the whole reason this constant is here rather than beside its producer: the
 * hub has to recognise the placeholder to refuse it, and a second copy of
 * "0000000" would be a second thing to keep in step.
 */
export const NO_COMMIT_SHA = "0000000";

/**
 * Is this string a commit a claim can actually be BOUND to?
 *
 * One predicate, because "looks like an object name" and "is a real
 * observation point" are different questions and only the second one decides
 * `commit_binding`. Two values pass the pattern and fail this: the placeholder
 * above, and — via the pattern — nothing else, but the pattern itself refuses
 * the other real case, a session registered with a LABEL rather than a sha
 * (`crosscheck conference` registers with the literal "conference", and
 * `SessionSchema.baseCommit` is `z.string().min(1)`, so the hub stores it).
 */
export const isBindableCommit = (value: string): boolean =>
  COMMIT_SHA_PATTERN.test(value) && value !== NO_COMMIT_SHA;
