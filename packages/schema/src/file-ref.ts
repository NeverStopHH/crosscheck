/**
 * ONE FILE, ONE SPELLING — and the identity hashed from it (1.0 spec 01a
 * §3.3d).
 *
 * A pin and a touch meet only when they spell the same file the same way. The
 * `suspect` intersection is an exact-string join between `pin_files.path` and
 * `work_context_targets.value`, so a pin stored as `./src/x.ts` against a touch
 * of `src/x.ts` finds nobody and says "no session touched this surface" — an
 * exoneration produced by a spelling, which is the direction nobody reports.
 * And 01a's retention graph joins the same two sides through `fileRef`, so the
 * same mismatch would read "no pin references this session" and DELETE it.
 *
 * ONE CANONICALISATION, pure and synchronous, imported by both the connector
 * and the hub, applied at every door a path comes through. It never touches a
 * filesystem: what it cannot settle — case on a case-insensitive disk, a path
 * typed relative to a subdirectory — is settled by git at the pin door
 * (cli/src/cli/pin-paths.ts), not guessed here.
 *
 * A PATH IT CANNOT MAKE CANONICAL IS REFUSED WITH ITS REASON, never passed
 * through: a stored spelling that matches nothing watches nothing while
 * reading as registered.
 */

/** The domain tag, so a file identity can never equal another digest's bytes. */
export const FILE_REF_DOMAIN = "crosscheck:file-ref:v1";

export const CANONICAL_PATH_REFUSALS = [
  /** Nothing left once the `.` segments and slashes are gone. */
  "empty",
  /** A leading slash: a repo-relative path never has one. */
  "absolute",
  /** A `..` segment: it can leave the repository, and never names a file in it. */
  "parent_segment",
  /** NUL, CR or LF: the last two are the file identity's field separator. */
  "control_character",
  /** A backslash is a name character on POSIX and a separator on Windows — ambiguous, so refused. */
  "backslash",
] as const;

export type CanonicalPathRefusal = (typeof CANONICAL_PATH_REFUSALS)[number];

export type CanonicalPath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: CanonicalPathRefusal };

const CONTROL = /[\u0000\r\n]/;

const refused = (reason: CanonicalPathRefusal): CanonicalPath => ({
  ok: false,
  reason,
});

/**
 * POSIX separators, `//` and `.` segments collapsed, a leading `./` and a
 * trailing `/` dropped, Unicode NFC — and `..`, NUL, CR, LF, a backslash and
 * an absolute path refused.
 *
 * NFC because git stores composed names (`core.precomposeunicode`) while a
 * macOS filesystem can hand back decomposed ones, and the two spellings of
 * `café` are different strings to every join in this product.
 */
export const canonicalRepoPath = (raw: string): CanonicalPath => {
  if (CONTROL.test(raw)) {
    return refused("control_character");
  }
  if (raw.includes("\\")) {
    return refused("backslash");
  }
  if (raw.startsWith("/")) {
    return refused("absolute");
  }
  const segments = raw
    .normalize("NFC")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.includes("..")) {
    return refused("parent_segment");
  }
  if (segments.length === 0) {
    return refused("empty");
  }
  return { ok: true, path: segments.join("/") };
};

/**
 * THE FILE IDENTITY the retention graph joins a pin to a touch through
 * (§3.3d): SHA-256 over the domain, the repo identity and the canonical path,
 * newline-joined — `targetDigest`'s encoding, with its own domain.
 *
 * The separator is safe only because neither field may contain it, so both
 * are checked here rather than trusted: a repo identity or a path carrying a
 * newline would let two different (repo, path) pairs hash the same bytes.
 * Throwing is the right failure — a caller that reaches this with such a value
 * has skipped `canonicalRepoPath`, and a silently wrong identity would be read
 * downstream as "nothing references this".
 */
export const fileRef = (repoIdentity: string, canonicalPath: string): string => {
  if (CONTROL.test(repoIdentity) || CONTROL.test(canonicalPath)) {
    throw new Error("fileRef: a field carries the identity's separator");
  }
  return new Bun.CryptoHasher("sha256")
    .update([FILE_REF_DOMAIN, repoIdentity, canonicalPath].join("\n"))
    .digest("hex");
};
