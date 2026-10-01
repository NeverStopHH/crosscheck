/**
 * THE ONLY HUMAN INPUT THE PILOT TAKES (1.0 spec 07 §3.2, revised §12), on
 * the wire.
 *
 * Three gestures, each riding something a person does anyway, and none is a
 * question. `crosscheck pilot label` walks a reader's own recent interventions
 * and takes one key per intervention — helpful, noise, unclear — after the
 * session, when the person chooses to; `crosscheck noise` is the one-word
 * shortcut for the middle key; `crosscheck pin --ok` is the missing symmetric
 * half of `crosscheck pin --broke`.
 *
 * ONE BOUNDED SENTENCE MAY RIDE A LABEL, and that is a revision stated rather
 * than slipped in: §8.3 refused a survey, and this is not one — nothing asks,
 * nothing waits, and an empty reason is the ordinary case. The bound is the
 * pin recipe's, the hub secret-scans it before storing it, and it is rendered
 * to nobody but the per-repo report, quoted and cleaned like every other
 * author-written span.
 *
 * `presence` IS EVIDENCE, NOT A VERDICT — #50's pin rule, copied with its
 * stated limit. The body says what the client OBSERVED; the hub stamps
 * `capture_mode` itself. A body that could say "human" would be an agent
 * grading its own homework on the one axis that measures whether this product
 * is worth installing.
 */
import { z } from "zod";

import {
  PILOT_MARKS,
  PILOT_MARKS_BY_REF_KIND,
  PILOT_MARK_REF_KINDS,
} from "./enums.ts";
import { MAX_PIN_CHECK_CHARS, PIN_PRESENCE_TERMINAL } from "./pin.ts";

/**
 * THE SAME 200 as `MAX_PIN_CHECK_CHARS` and `MAX_WAIVER_REASON_CHARS` — one
 * human sentence about one thing. Derived from the pin cap rather than
 * repeated, so the two cannot drift into two answers to "how much may a
 * person write here":
 *
 * VERIFY: bun -e 'const m=await import("./packages/schema/src/pilot-mark.ts");const p=await import("./packages/schema/src/pin.ts");console.log(m.MAX_PILOT_LABEL_REASON_CHARS === p.MAX_PIN_CHECK_CHARS)'
 * PRINTS: true
 *
 * AND THE THIRD AUTHORITY: `bootstrap.sql` spells the bound as a SQL literal,
 * because a CHECK cannot import a TypeScript constant. `ddl-sync.test.ts`
 * reddens on drift; this states the agreement where the number is decided:
 *
 * VERIFY: bun -e 'const m=await import("./packages/schema/src/pilot-mark.ts");const sql=await Bun.file("./packages/server/src/db/bootstrap.sql").text();const r=/pilot_marks_reason_length_check\s+CHECK \(reason IS NULL OR char_length\(reason\) <= (\d+)\)/.exec(sql);console.log(r===null?"NO CHECK IN bootstrap.sql":String(Number(r[1])===m.MAX_PILOT_LABEL_REASON_CHARS))'
 * PRINTS: true
 */
export const MAX_PILOT_LABEL_REASON_CHARS = MAX_PIN_CHECK_CHARS;

/**
 * ONE MEASURE: CODE POINTS (second review, L7). zod's `.max` and Postgres's
 * `char_length` both count code points; the walk counted UTF-16 units and
 * the renderer cut at 200 of them, so 150 emoji were refused at the terminal
 * yet accepted by the hub, and printed cut off. Every reader of this bound
 * counts with `reasonLength`.
 */
export const reasonLength = (text: string): number => [...text].length;

/**
 * The renderer's budget for a stored reason, in the UTF-16 units its cut
 * counts: a code point is at most two of them, so a reason the hub accepted
 * is never cut.
 */
const MAX_UTF16_UNITS_PER_CODE_POINT = 2;
export const MAX_PILOT_LABEL_REASON_UTF16_UNITS =
  MAX_PILOT_LABEL_REASON_CHARS * MAX_UTF16_UNITS_PER_CODE_POINT;

const takesMark = (refKind: keyof typeof PILOT_MARKS_BY_REF_KIND, mark: string): boolean =>
  (PILOT_MARKS_BY_REF_KIND[refKind] as readonly string[]).includes(mark);

export const PilotMarkSchema = z
  .looseObject({
    repo: z.string().min(1),
    refKind: z.enum(PILOT_MARK_REF_KINDS),
    refId: z.string().min(1),
    mark: z.enum(PILOT_MARKS),
    /**
     * REQUIRED, so an absent value is a parse failure and never a default.
     * The gate has to fail CLOSED: a mark that arrived without the claim is a
     * mark nobody can say a human made.
     */
    presence: z.literal(PIN_PRESENCE_TERMINAL),
    /** Optional, trimmed, bounded: a blank is no reason, and an over-long one is refused here. */
    reason: z.string().trim().min(1).max(MAX_PILOT_LABEL_REASON_CHARS).optional(),
  })
  .refine((body) => takesMark(body.refKind, body.mark), {
    path: ["mark"],
    message:
      "a delivery takes `helpful`, `noise` or `unclear` (crosscheck pilot label) and a pin takes `surface_ok` (crosscheck pin --ok)",
  })
  // A REASON RIDES A LABEL. `pin --ok` takes no sentence: the recipe is the
  // whole message, and a second text slot would be a second thing to scan,
  // bound and render for a gesture that never needed one.
  .refine((body) => body.reason === undefined || body.refKind === "hint_delivery", {
    path: ["reason"],
    message: "a reason goes with an intervention label; `pin --ok` takes none",
  });

export type PilotMarkInput = z.infer<typeof PilotMarkSchema>;
