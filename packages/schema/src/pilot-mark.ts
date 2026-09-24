/**
 * THE ONLY HUMAN INPUT THE PILOT TAKES (1.0 spec 07 §3.2), on the wire.
 *
 * Two gestures, each riding something a person does anyway, and neither is a
 * question. `crosscheck noise` is typed beside a session that got a bad
 * intervention; `crosscheck pin ok` is the missing symmetric half of
 * `crosscheck pin --broke` — whoever ran the recipe and watched it PASS gets
 * the same one-line gesture as whoever watched it fail, which is what makes a
 * pin's notice falsifiable in both directions.
 *
 * NO FREE TEXT, AND THAT IS A REFUSAL RATHER THAN AN OMISSION. §8.3 declines
 * to add a survey: a measurement that interrupts somebody to ask how the
 * measurement is going has changed the thing it measures, and a comment field
 * would put a person's prose on a surface that data minimisation keeps to
 * ids, enums and timestamps. The gesture IS the whole message.
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
  PILOT_MARK_BY_REF_KIND,
  PILOT_MARK_REF_KINDS,
} from "./enums.ts";
import { PIN_PRESENCE_TERMINAL } from "./pin.ts";

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
  })
  .refine((body) => PILOT_MARK_BY_REF_KIND[body.refKind] === body.mark, {
    path: ["mark"],
    message:
      "a delivery takes `off_target` (crosscheck noise) and a pin takes `surface_ok` (crosscheck pin ok)",
  });

export type PilotMarkInput = z.infer<typeof PilotMarkSchema>;
