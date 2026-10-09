/**
 * THE CLIENT'S RELEASE, ON EVERY HUB REQUEST (human provenance §10, round 2).
 *
 * A 0.11 client reads a drafted answer as a draft: "drafted … it counts only
 * once you confirm it with your passkey". A 0.10 client predates drafts, sends
 * no release, and says "recorded" over the same answer. A hub started with
 * `CROSSCHECK_REFUSE_PRE_011_DRAFTS=1` refuses its drafting doors to a request
 * that names no release, or one older than `FIRST_DRAFTING_CLIENT_RELEASE`,
 * with a sentence the 0.10 CLI prints as it is.
 *
 * NOT A SECURITY CONTROL: any program can send the header. It only keeps an
 * old client from telling its user that something was recorded when it was
 * only drafted.
 */

/** The header every hub request carries. */
export const CLIENT_RELEASE_HEADER = "x-crosscheck-client";

/**
 * The release line this client's hub protocol speaks, decoupled from the
 * package version: bumped when a client learns an answer a hub may rely on.
 */
export const CLIENT_RELEASE = "0.11.0";

/** The first release whose clients read a drafted answer as a draft. */
export const FIRST_DRAFTING_CLIENT_RELEASE = "0.11.0";

const RELEASE_PATTERN = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

const partsOf = (release: string): readonly number[] | null => {
  const match = RELEASE_PATTERN.exec(release);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

/**
 * Whether `release` (a header value, or none) is `floor` or newer. A missing
 * or malformed value is older than every floor: a client that names no
 * release is read as one from before releases were named.
 */
export const isReleaseAtLeast = (release: string | null | undefined, floor: string): boolean => {
  const given = release === null || release === undefined ? null : partsOf(release.trim());
  const least = partsOf(floor);
  if (given === null || least === null) {
    return false;
  }
  const differing = given.findIndex((part, index) => part !== least[index]);
  return differing === -1 || (given[differing] ?? 0) > (least[differing] ?? 0);
};
