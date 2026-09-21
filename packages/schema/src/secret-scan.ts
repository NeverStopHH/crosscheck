/**
 * Local secret scan (DESIGN.md §3): runs before anything leaves the machine,
 * and — since spec 06 — again at the hub, on the fields a connector is not the
 * only writer of. A hit means "drop the record", never "redact and upload":
 * a redacted derivative still leaks structure.
 *
 * IT LIVES IN `schema` RATHER THAN IN `connector-core`, and the move is the
 * point. The repo's own rule is "one helper, every writer"
 * (`capture-bookkeeping.ts`), and the hub is the one place EVERY writer passes
 * through — a connector-side screen is bypassed by anything that posts to
 * `/api/records` directly. `schema` sits below both the connector and the
 * server, so this is the only package both of them can reach.
 *
 * `connector-core/src/capture/secret-scan.ts` re-exports it, so all of its
 * existing call sites keep their import and none of them had to change.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /xox[abporsu]-[A-Za-z0-9-]{10,}/,
  /sk-(ant-)?[A-Za-z0-9_-]{16,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  // ANCHORED AT A TOKEN BOUNDARY, and the lookbehind is load-bearing for COST
  // rather than for correctness. A JWT needs a dot after `eyJ`; a body full of
  // "eyJeyJeyJ…" has none, so the engine used to rescan to the end of the
  // string from EVERY one of the n start positions — clean O(n^2). Measured
  // at 10,000 characters that was 17 ms for a single call against 0.05 ms for
  // ordinary prose of the same size, and about 540x what the same shape cost
  // at the old 400-character body cap.
  //
  // A real JWT is never preceded by another token character, so requiring
  // that collapses n starts to the handful that could actually match. It
  // narrows nothing a secret would occupy: this scan looks for a credential
  // in text, and one glued to the tail of an identifier is not a credential
  // it was finding before.
  //
  // The rate this matters at is not hypothetical — flows/hint.ts scans the
  // WHOLE user prompt on UserPromptSubmit, which is a keystroke path with no
  // length bound at all, so a pasted stack trace lands here.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  // Same shape, same fix: the unanchored `[^\s@]+@` tail rescanned to the end
  // from every repeated scheme in "postgres://a:bpostgres://a:b…".
  /(?<![A-Za-z0-9_-])(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@]+@/,
  /(api[_-]?key|secret|token|password|passwd|bearer)["'\s:=]{1,4}[A-Za-z0-9/+_-]{16,}/i,
];

export const containsSecret = (text: string): boolean => {
  if (text.length === 0) {
    return false;
  }
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
};
