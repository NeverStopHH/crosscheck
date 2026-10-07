/**
 * Last segment of the shared repo id (`github.com/acme/api` → `api`). The
 * title builder composes `<branch> @ <label>` with it (flows/register-
 * session.ts) and the briefing strips the same suffix to read a title's topic
 * (briefing/render.ts). It lives in @crosscheck/schema, beside
 * `isFallbackTitle`, because the hub reads the same shape to withhold a
 * fallback title — which IS a branch — from viewers an opted-out developer's
 * location is hidden from: one spelling for both sides of the wire.
 */
export { repoLabel } from "@crosscheck/schema";
