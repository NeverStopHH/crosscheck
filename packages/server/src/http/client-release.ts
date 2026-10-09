/**
 * REFUSING DRAFTS FROM CLIENTS OLDER THAN 0.11 (human provenance §10, round
 * 2), an opt-in hub setting: `CROSSCHECK_REFUSE_PRE_011_DRAFTS=1`.
 *
 * A 0.10 client sends no release and prints "recorded" over what the hub only
 * drafted. With the setting on, every DRAFTING door (labels, ratings, pins,
 * breaks, mutes and unmutes, presence back on) refuses a request that names
 * no release or an older one, with one sentence the 0.10 CLI prints as it is
 * (it prints a hub refusal bare). Reads and switching presence off are never
 * refused: an opt-out never waits, and a read writes nothing.
 *
 * NOT A SECURITY CONTROL. Any program can send the header. It only keeps an
 * old client from telling its user that something was recorded when it was
 * only drafted; what counts is still decided by the passkey alone.
 */
import type { Context } from "hono";
import { CLIENT_RELEASE_HEADER, FIRST_DRAFTING_CLIENT_RELEASE, isReleaseAtLeast } from "@crosscheck/schema";

import { fail } from "./envelope.ts";
import type { AppEnv } from "../types.ts";

export const REFUSE_PRE_011_DRAFTS_ENV = "CROSSCHECK_REFUSE_PRE_011_DRAFTS";

/** Within MAX_REFUSAL_CHARS (services/refusal.ts), so a 0.10 client prints it whole. */
export const PRE_DRAFTING_CLIENT_SENTENCE =
  "this hub takes labels, ratings, pins and settings only from crosscheck 0.11 or newer, which asks for your passkey: upgrade crosscheck, then say it again — nothing was recorded";

const ON = "1";
const OFF: readonly (string | undefined)[] = [undefined, "", "0"];

/** `1` is on; unset, empty and `0` are off; anything else stops the hub at start-up rather than guessing. */
export const parseRefusePreDraftingClients = (raw: string | undefined): boolean => {
  if (raw === ON) {
    return true;
  }
  if (OFF.includes(raw)) {
    return false;
  }
  throw new Error(
    `${REFUSE_PRE_011_DRAFTS_ENV} must be 1 (refuse drafts from clients older than 0.11) or 0 / unset (accept every client)`,
  );
};

/** The refusal a drafting door answers a client older than 0.11 with, or null to go on. */
export const refusePreDraftingClient = (
  c: Context<AppEnv>,
  deps: { readonly refusePreDraftingClients: boolean },
): Response | null =>
  deps.refusePreDraftingClients && !isReleaseAtLeast(c.req.header(CLIENT_RELEASE_HEADER), FIRST_DRAFTING_CLIENT_RELEASE)
    ? fail(c, 422, "client_upgrade_required", PRE_DRAFTING_CLIENT_SENTENCE)
    : null;
