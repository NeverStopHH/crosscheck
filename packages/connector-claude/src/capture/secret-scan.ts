/**
 * Local secret scan (DESIGN.md §3): runs before anything leaves the machine.
 * A hit means "drop the record", never "redact and upload" — a redacted
 * derivative still leaks structure.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /xox[abporsu]-[A-Za-z0-9-]{10,}/,
  /sk-(ant-)?[A-Za-z0-9_-]{16,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@]+@/,
  /(api[_-]?key|secret|token|password|passwd|bearer)["'\s:=]{1,4}[A-Za-z0-9/+_-]{16,}/i,
];

export const containsSecret = (text: string): boolean => {
  if (text.length === 0) {
    return false;
  }
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
};