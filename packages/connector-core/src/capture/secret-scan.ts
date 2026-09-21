/**
 * The local secret scan, re-exported from `@crosscheck/schema`.
 *
 * THE DEFINITION MOVED, THE IMPORT DID NOT. Spec 06 added two agent-written
 * text fields the connector is not the only writer of — an amendment `reason`
 * and every `intent_scope.value` — and anything posting to `/api/records`
 * reaches them without passing a connector at all. The repo's own rule is
 * "one helper, every writer", and the only place every writer passes is the
 * hub, which can import `schema` and cannot import this package.
 *
 * So the patterns live in `schema/src/secret-scan.ts` and this file keeps the
 * name its eight call sites already use. One scanner, two sides.
 */
export { containsSecret } from "@crosscheck/schema";
