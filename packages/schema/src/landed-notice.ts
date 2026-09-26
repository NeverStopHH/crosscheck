/**
 * The author's notice (docs/1.0/landed-changes.md, step 4): two records.
 *
 * `landed_stop` — a reader's pre-edit stop at a teammate's landed change,
 * spooled once the stop is booked. It carries only the commits whose author
 * the stop NAMED as told (decision 11), each with the developer the hub's
 * why answer mapped its address to; the hub checks that mapping again and
 * never tells anybody else. The address is for that check and is not stored.
 *
 * `landed_notice_delivery` — the author's connector marking the notices it
 * showed, so each is told once. The hub applies it only to notices
 * addressed to its sender.
 *
 * Neither carries an id of its own: both effects are idempotent (a stop
 * lands on a unique row per reader, file and commit; a delivery sets a time
 * that is set once), so a spool replay changes nothing.
 */
import { z } from "zod";

import {
  LANDED_CONTEXT_MAX_COMMITS,
  LandedAuthorEmailSchema,
  LandedPathSchema,
  LandedRepoSchema,
} from "./landed-context.ts";

/** A commit subject as the notice quotes it; the connector cuts a longer one. */
export const LANDED_STOP_MAX_SUBJECT_CHARS = 200;
/** Notices one delivery may mark: a briefing's shown groups, with room. */
export const LANDED_NOTICE_MAX_DELIVERED = 100;

const nonEmptyId = z.string().min(1);

/**
 * One commit, ONE spelling: a full object name in lower case (SHA-1 or
 * SHA-256), exactly what `git log %H` prints. The hub keeps one row per
 * reader, file and commit; an abbreviation or an upper-case copy would be a
 * second row, and the author would be told the same commit twice.
 */
const FULL_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const LandedStopCommitSchema = z.object({
  sha: z.string().regex(FULL_SHA_PATTERN),
  /** Written by the author; reaches them through the reader's connector: quoted data. */
  subject: z.string().max(LANDED_STOP_MAX_SUBJECT_CHARS),
  /** After the reader's .mailmap: what the why answer was asked with. */
  authorEmail: LandedAuthorEmailSchema,
  /** Whom the why answer said this address belongs to — and the stop named. */
  authorDeveloperId: nonEmptyId,
  /** Missing from the reader's checkout, or already in it and recent (decision 8). */
  missing: z.boolean(),
});

export const LandedStopSchema = z.object({
  /** The READER's session — the one that was stopped. */
  sessionId: nonEmptyId,
  repo: LandedRepoSchema,
  path: LandedPathSchema,
  /** The reader's clock; the hub bounds it by its own. */
  stoppedAt: z.iso.datetime({ offset: true }),
  commits: z.array(LandedStopCommitSchema).min(1).max(LANDED_CONTEXT_MAX_COMMITS),
});

export type LandedStopCommit = z.infer<typeof LandedStopCommitSchema>;
export type LandedStop = z.infer<typeof LandedStopSchema>;

export const LandedNoticeDeliverySchema = z.object({
  /** The AUTHOR's session — the one that showed the notices. */
  sessionId: nonEmptyId,
  noticeIds: z.array(nonEmptyId).min(1).max(LANDED_NOTICE_MAX_DELIVERED),
  deliveredAt: z.iso.datetime({ offset: true }),
});

export type LandedNoticeDelivery = z.infer<typeof LandedNoticeDeliverySchema>;
