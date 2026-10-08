/**
 * The human-provenance hub call (0.11 §6, §9): how many of the caller's drafts
 * wait for their passkey, whether a passkey can confirm anything on this hub,
 * and whether the caller's own passkeys belong to an RP this hub accepts.
 *
 * Read by `crosscheck confirm` and doctor. Counts and words only: what a
 * draft says is read on the hub's own page, never printed here, where an
 * agent may be the one reading.
 */
import { z } from "zod";

import { hubRequest } from "./client.ts";
import type { HubContext, HubResult } from "./client.ts";

const CountSchema = z.number().int().min(0);

/** What an older hub answers a route it does not have. */
export const CONFIRM_NOT_SERVED_STATUS = 404;

export const ConfirmStatusSchema = z.looseObject({
  pending: CountSchema,
  /** Per kind; a kind this client does not know is counted all the same. */
  pendingByKind: z.record(z.string(), CountSchema),
  /** An unknown word reads as the most cautious one: nothing can be confirmed here. */
  humanConfirmation: z.enum(["https", "hub_machine_only", "none"]).catch("none"),
  passkeys: z.looseObject({ total: CountSchema, atConfiguredRp: CountSchema }),
  /** The hub's own hostnames — text the hub chose, printed only through the untrusted-text class. */
  rpIds: z.array(z.string()),
});

export type ConfirmStatus = z.infer<typeof ConfirmStatusSchema>;

export const getConfirmStatus = (ctx: HubContext): Promise<HubResult<ConfirmStatus>> =>
  hubRequest(ctx, { method: "GET", path: "/api/confirm/status", schema: ConfirmStatusSchema });

/** The page a person confirms their drafts on — built from the configured hub url and a fixed path, never from hub text. */
export const CONFIRM_PAGE_PATH = "/ui/confirm";

export const confirmPageUrl = (hubUrl: string): string => `${hubUrl.replace(/\/+$/, "")}${CONFIRM_PAGE_PATH}`;
