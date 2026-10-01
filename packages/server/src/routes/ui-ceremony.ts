/**
 * THE TWO CEREMONY ENDPOINTS behind /ui/webauthn (1.0 spec 04a §5–§6):
 * `options` mints a challenge over exactly the submitted fields; `verify`
 * recomputes those terms from the same fields, checks the signature, and only
 * then performs the action. A ceremony is one of six actions, each with its
 * own terms, and the hub — never the browser — builds them.
 *
 * WHAT IS TRUSTED FROM THE REQUEST, AND WHAT IS NOT:
 *   - the session cookie names the developer (ui.tsx's middleware);
 *   - the `x-crosscheck-csrf` header must match that session (the forms' CSRF
 *     rule, carried as a header because this is a JSON fetch);
 *   - the `Origin` header picks the RP ID. A browser always sends it on a
 *     same-origin POST and a page cannot forge it; a script outside a browser
 *     can, but then the authenticator's signed `clientDataJSON.origin` must
 *     still match, and the library refuses when it does not;
 *   - the credential must be one of the SIGNED-IN developer's usable passkeys
 *     — another developer's passkey, a revoked one or one still cooling off
 *     never reaches the signature check (PK-7, PK-9).
 */
import { createHash } from "node:crypto";

import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { MAX_PASSKEY_LABEL_CHARS, MAX_WAIVER_REASON_CHARS } from "@crosscheck/schema";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

import { fenceWaivers } from "../db/schema.ts";
import { fail, ok } from "../http/envelope.ts";
import { formatIssues, readJsonBody } from "../http/request.ts";
import {
  enrolPasskey,
  enrolledCredentials,
  isEnrolmentCodeValid,
  mintEnrolmentCode,
  recordSignCount,
  revokePasskey,
  usableCredentials,
} from "../services/passkeys.ts";
import { amendWaiver, approveRequest, readPendingRequest } from "../services/waiver-requests.ts";
import type { WaiverRequestRefusal } from "../services/waiver-requests.ts";
import { readLiveWaiver, revokeWaiver } from "../services/waivers.ts";
import type { CeremonyPurpose, CeremonyTerms, WebAuthn } from "../services/webauthn.ts";
import { isCsrfValid } from "../ui/session.ts";
import type { AppDeps, AppEnv } from "../types.ts";
import { WAIVER_REQUEST_SENTENCE } from "./waiver-sentences.ts";

const CSRF_HEADER = "x-crosscheck-csrf";
const MAX_SUBJECT_CHARS = 200;
const MAX_CODE_CHARS = 64;

const Subject = z.string().min(1).max(MAX_SUBJECT_CHARS);
const Reason = z.string().trim().min(1).max(MAX_WAIVER_REASON_CHARS);

/** The six actions and the fields each one signs. */
const CeremonyFieldsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("enrol"),
    code: z.string().min(1).max(MAX_CODE_CHARS),
    label: z.string().trim().min(1).max(MAX_PASSKEY_LABEL_CHARS),
  }),
  z.object({ action: z.literal("authorise_enrolment") }),
  z.object({ action: z.literal("approve"), subjectId: Subject, expiresAt: z.iso.datetime(), reason: Reason }),
  z.object({ action: z.literal("amend"), subjectId: Subject, expiresAt: z.iso.datetime(), reason: Reason }),
  z.object({ action: z.literal("revoke_waiver"), subjectId: Subject, reason: Reason }),
  z.object({ action: z.literal("revoke_passkey"), subjectId: Subject }),
]);

type CeremonyFields = z.infer<typeof CeremonyFieldsSchema>;
type AssertionFields = Exclude<CeremonyFields, { action: "enrol" }>;

/** The authenticator's answer: its shape is the library's to judge; this only finds its id. */
const VerifyExtrasSchema = z.object({
  ceremonyId: z.string().min(1).max(MAX_SUBJECT_CHARS),
  response: z.looseObject({ id: z.string().min(1), response: z.looseObject({}) }),
});

/** One sentence per refusal a person can meet on these two endpoints. */
const CEREMONY_SENTENCE = {
  missing_origin: "the request carried no Origin — open the page in a browser",
  origin_not_configured:
    "this hub does not accept passkeys at this address — use one listed in CROSSCHECK_WEBAUTHN_ORIGINS",
  no_passkey_for_origin:
    "you have no passkey that can sign here yet — a new one waits a day, and a passkey works only at the address it was enrolled at",
  too_many_ceremonies: "too many unfinished passkey prompts — finish one, or wait five minutes",
  unknown_ceremony: "that passkey prompt was already used or never existed — press the button again",
  ceremony_expired: "that passkey prompt expired — press the button again",
  wrong_ceremony: "that passkey answer belongs to a different prompt — press the button again",
  response_rejected: "the passkey's answer did not verify — nothing was changed",
  code_invalid:
    "that enrolment code is unknown, used, expired, or for somebody else — ask the admin for a new one",
  credential_already_enrolled: "this passkey is already enrolled",
  unknown_credential:
    "that passkey cannot do this: it is somebody else's, still cooling off, or revoked",
  unknown_passkey: "you have no passkey with that id",
  already_revoked: "that passkey has already been revoked",
  passkey_required: "after its first day a passkey is revoked with a passkey",
} as const;

type CeremonyRefusal = keyof typeof CEREMONY_SENTENCE;

const refuse = (c: Context<AppEnv>, refusal: CeremonyRefusal) =>
  fail(c, 422, refusal, CEREMONY_SENTENCE[refusal]);

const refuseWaiver = (c: Context<AppEnv>, refusal: WaiverRequestRefusal) =>
  fail(c, 422, refusal, WAIVER_REQUEST_SENTENCE[refusal]);

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

interface Signed {
  readonly purpose: CeremonyPurpose;
  readonly subject: string;
  readonly terms: CeremonyTerms;
}

/** The terms a ceremony signs, built by the hub from the fields and the stored request. */
const signedTermsOf = async (
  deps: AppDeps,
  developerId: string,
  fields: AssertionFields,
): Promise<Signed | { refusal: WaiverRequestRefusal }> => {
  switch (fields.action) {
    case "authorise_enrolment":
      return { purpose: fields.action, subject: developerId, terms: {} };
    case "approve": {
      const request = await readPendingRequest({ db: deps.db, requestId: fields.subjectId, now: deps.now() });
      if ("refusal" in request) {
        return request;
      }
      return {
        purpose: fields.action,
        subject: fields.subjectId,
        terms: {
          pinId: request.pinId,
          pinVersion: request.pinVersion,
          expiresAt: fields.expiresAt,
          reasonDigest: digest(fields.reason),
        },
      };
    }
    case "amend":
      return {
        purpose: fields.action,
        subject: fields.subjectId,
        terms: { expiresAt: fields.expiresAt, reasonDigest: digest(fields.reason) },
      };
    case "revoke_waiver":
      return { purpose: fields.action, subject: fields.subjectId, terms: { reasonDigest: digest(fields.reason) } };
    case "revoke_passkey":
      return { purpose: fields.action, subject: fields.subjectId, terms: {} };
  }
};

/** CSRF, then the fields, then the origin: what both endpoints refuse before any ceremony logic. */
const readCeremonyRequest = async (
  c: Context<AppEnv>,
  deps: AppDeps,
): Promise<{ fields: CeremonyFields; body: unknown; origin: string } | Response> => {
  if (!isCsrfValid(deps.uiSessionSecret, c.get("uiSessionToken"), c.req.header(CSRF_HEADER) ?? "")) {
    return fail(c, 403, "csrf_invalid", "invalid or missing CSRF token — reload the page");
  }
  const body = await readJsonBody(c);
  const parsed = CeremonyFieldsSchema.safeParse(body);
  if (!parsed.success) {
    return fail(c, 400, "validation_failed", formatIssues(parsed.error));
  }
  const origin = c.req.header("origin");
  if (origin === undefined) {
    return refuse(c, "missing_origin");
  }
  return { fields: parsed.data, body, origin };
};

export const ceremonyOptions = async (
  c: Context<AppEnv>,
  deps: AppDeps,
  webauthn: WebAuthn,
): Promise<Response> => {
  const request = await readCeremonyRequest(c, deps);
  if (request instanceof Response) {
    return request;
  }
  const developer = c.get("developer");
  const { fields, origin } = request;
  if (fields.action === "enrol") {
    const valid = await isEnrolmentCodeValid({
      db: deps.db,
      developerId: developer.id,
      code: fields.code,
      now: deps.now(),
    });
    if (!valid) {
      return refuse(c, "code_invalid");
    }
    const minted = await webauthn.registrationOptions({
      developerId: developer.id,
      userName: developer.email,
      origin,
      existing: await enrolledCredentials({ db: deps.db, developerId: developer.id }),
    });
    return "refusal" in minted
      ? refuse(c, minted.refusal)
      : ok(c, { ceremonyId: minted.ceremonyId, publicKey: minted.options });
  }
  const signed = await signedTermsOf(deps, developer.id, fields);
  if ("refusal" in signed) {
    return refuseWaiver(c, signed.refusal);
  }
  const usable = await usableCredentials({ db: deps.db, developerId: developer.id, now: deps.now() });
  const minted = await webauthn.authenticationOptions({
    developerId: developer.id,
    ...signed,
    origin,
    credentials: usable.map((entry) => entry.credential),
  });
  return "refusal" in minted
    ? refuse(c, minted.refusal)
    : ok(c, { ceremonyId: minted.ceremonyId, publicKey: minted.options });
};

const waiverTargetOf = async (
  deps: AppDeps,
  waiverId: string,
): Promise<{ repo: string; pinId: string; pinVersion: number } | null> => {
  const rows = await deps.db
    .select({ repo: fenceWaivers.repo, pinId: fenceWaivers.pinId, pinVersion: fenceWaivers.pinVersion })
    .from(fenceWaivers)
    .where(eq(fenceWaivers.id, waiverId))
    .limit(1);
  return rows[0] ?? null;
};

/**
 * WHAT THE FENCE IS AFTER A CLOSE, read back rather than assumed. One live
 * grant per fence is the rule (services/waiver-requests.ts), but a grant from
 * before it — or one written past it — would keep the fence open, and "shut
 * again" would then be a sentence the verdict contradicts.
 */
const closedSentence = async (
  deps: AppDeps,
  target: { repo: string; pinId: string; pinVersion: number },
): Promise<string> => {
  const still = await readLiveWaiver({ db: deps.db, ...target, now: deps.now() });
  return still === null
    ? "Closed — the fence is shut again."
    : `Closed that waiver — but the fence is STILL OPEN until ${still.expiresAt} under another one; close that too.`;
};

/** Amend or close a fence: both need the waiver's repo, which the page does not send. */
const performOnWaiver = async (
  c: Context<AppEnv>,
  deps: AppDeps,
  fields: Extract<AssertionFields, { action: "amend" | "revoke_waiver" }>,
  credentialId: string,
): Promise<Response> => {
  const target = await waiverTargetOf(deps, fields.subjectId);
  if (target === null) {
    return refuseWaiver(c, "unknown_waiver");
  }
  const { repo } = target;
  const developerId = c.get("developer").id;
  const outcome =
    fields.action === "amend"
      ? await amendWaiver({
          db: deps.db,
          repo,
          waiverId: fields.subjectId,
          approverId: developerId,
          credentialId,
          expiresAt: new Date(fields.expiresAt),
          reason: fields.reason,
          now: deps.now(),
        })
      : await revokeWaiver({
          db: deps.db,
          repo,
          waiverId: fields.subjectId,
          grantedBy: developerId,
          reason: fields.reason,
          now: deps.now(),
          credentialId,
        });
  if ("refusal" in outcome) {
    return refuseWaiver(c, outcome.refusal);
  }
  return ok(c, {
    message:
      fields.action === "amend"
        ? `Amended — the fence is open until ${fields.expiresAt}.`
        : await closedSentence(deps, target),
  });
};

/** The action a verified assertion authorises — and nothing before the signature held. */
const perform = async (
  c: Context<AppEnv>,
  deps: AppDeps,
  fields: AssertionFields,
  credentialId: string,
): Promise<Response> => {
  const developerId = c.get("developer").id;
  switch (fields.action) {
    case "authorise_enrolment": {
      const { code } = await mintEnrolmentCode({ db: deps.db, developerId, source: "passkey", now: deps.now() });
      return ok(c, { code });
    }
    case "approve": {
      const outcome = await approveRequest({
        db: deps.db,
        requestId: fields.subjectId,
        approverId: developerId,
        credentialId,
        expiresAt: new Date(fields.expiresAt),
        reason: fields.reason,
        now: deps.now(),
      });
      return "refusal" in outcome
        ? refuseWaiver(c, outcome.refusal)
        : ok(c, { message: `Approved — the fence is open until ${fields.expiresAt}.` });
    }
    case "amend":
    case "revoke_waiver":
      return performOnWaiver(c, deps, fields, credentialId);
    case "revoke_passkey": {
      const outcome = await revokePasskey({
        db: deps.db,
        passkeyId: fields.subjectId,
        by: { kind: "passkey", developerId },
        now: deps.now(),
      });
      return "refusal" in outcome ? refuse(c, outcome.refusal) : ok(c, { message: "Passkey revoked." });
    }
  }
};

const verifyEnrolment = async (
  c: Context<AppEnv>,
  deps: AppDeps,
  webauthn: WebAuthn,
  fields: Extract<CeremonyFields, { action: "enrol" }>,
  extras: z.infer<typeof VerifyExtrasSchema>,
): Promise<Response> => {
  const developerId = c.get("developer").id;
  const verified = await webauthn.verifyRegistration({
    ceremonyId: extras.ceremonyId,
    developerId,
    response: extras.response as unknown as RegistrationResponseJSON,
  });
  if ("refusal" in verified) {
    return refuse(c, verified.refusal);
  }
  const enrolled = await enrolPasskey({
    db: deps.db,
    developerId,
    code: fields.code,
    credential: verified.credential,
    label: fields.label,
    now: deps.now(),
  });
  return "refusal" in enrolled
    ? refuse(c, enrolled.refusal)
    : ok(c, { message: `Passkey enrolled. It can approve from ${enrolled.usableFrom.toISOString()}.` });
};

export const ceremonyVerify = async (
  c: Context<AppEnv>,
  deps: AppDeps,
  webauthn: WebAuthn,
): Promise<Response> => {
  const request = await readCeremonyRequest(c, deps);
  if (request instanceof Response) {
    return request;
  }
  const extras = VerifyExtrasSchema.safeParse(request.body);
  if (!extras.success) {
    return fail(c, 400, "validation_failed", formatIssues(extras.error));
  }
  const { fields } = request;
  if (fields.action === "enrol") {
    return verifyEnrolment(c, deps, webauthn, fields, extras.data);
  }
  const developerId = c.get("developer").id;
  const signed = await signedTermsOf(deps, developerId, fields);
  if ("refusal" in signed) {
    return refuseWaiver(c, signed.refusal);
  }
  const usable = await usableCredentials({ db: deps.db, developerId, now: deps.now() });
  const match = usable.find((entry) => entry.credential.id === extras.data.response.id);
  if (match === undefined) {
    return refuse(c, "unknown_credential");
  }
  const verified = await webauthn.verifyAssertion({
    ceremonyId: extras.data.ceremonyId,
    developerId,
    ...signed,
    credential: match.credential,
    response: extras.data.response as unknown as AuthenticationResponseJSON,
  });
  if ("refusal" in verified) {
    return refuse(c, verified.refusal);
  }
  await recordSignCount({ db: deps.db, credentialId: match.credential.id, counter: verified.newCounter });
  return perform(c, deps, fields, match.credential.id);
};
