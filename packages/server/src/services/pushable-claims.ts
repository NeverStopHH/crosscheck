/**
 * Which claims may drive a hint PUSHED at a teammate (DESIGN.md §4; the
 * draft-nudge review and review 1006b, L6): only what somebody vouched for.
 *
 * A derived draft is a model's guess its author has not reviewed — and a
 * discarded one, a guess its author threw away — so neither may lend a word
 * to the floor that qualifies a tree for a pushed hint, nor ride the hint
 * wire as one of its claims. Reproduced before this rule: a tree whose title
 * shared nothing with a prompt reached the reader as "It carries 1 claim"
 * through a draft's words alone, before discard and after. Confirming a
 * draft publishes a declared claim, which then may. (A draft's words can
 * still RANK a tree into the 10-row search pool, through the context's own
 * search document; the floor then refuses it — recall at worst, never a
 * hint.)
 *
 * A REFUTED claim never does either: a hypothesis its author rejected is not
 * a reason to point anybody anywhere. The one exception is a
 * `rejected_approach`, whose status is "rejected" by definition — it is the
 * negative knowledge §4 exists to carry, and it stays a pointer.
 *
 * The pull surfaces (search, get_diagnosis) are not this rule's business: a
 * reader who asks may read every row.
 */
import { and, eq, ne, or } from "drizzle-orm";

import { claims } from "../db/schema.ts";
import { DECLARED_PROVENANCE } from "./similarity-gate.ts";

const REJECTED_STATUS = "rejected";
const REJECTED_APPROACH_KIND = "rejected_approach";

/** In every push-path WHERE that reads `claims`. */
export const pushableClaimCondition = () =>
  and(
    eq(claims.provenance, DECLARED_PROVENANCE),
    or(ne(claims.status, REJECTED_STATUS), eq(claims.kind, REJECTED_APPROACH_KIND)),
  );
