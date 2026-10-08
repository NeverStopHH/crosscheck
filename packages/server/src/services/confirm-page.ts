/**
 * WHAT THE PERSON SEES BEFORE THEY SIGN (human provenance §6, step 2): every
 * pending draft with the context it needs to be judged — who drafted it (by
 * class), when, which hint it is about and whose work that hint pointed at,
 * or which pin, teammate or setting. Read-only, the caller's own drafts only.
 *
 * Titles and names are other people's text: returned as data, escaped and
 * capped by the page. A pointer at another repo's work names nothing (07
 * §11.9): the title is joined only within the draft's own repo.
 */
import { sql } from "drizzle-orm";
import { DRAFT_KINDS } from "@crosscheck/schema";
import type { DraftKind, DraftProvenance } from "@crosscheck/schema";

import { pendingFingerprint, readPendingDrafts } from "./human-drafts.ts";
import type { DraftPayload, DraftRow } from "./human-drafts.ts";
import { locationHiddenFrom, projectRow, titleSourceOf } from "./live-location.ts";
import type { HiddenLocations } from "./live-location.ts";
import { POINTED_WORK_CONTEXT } from "./pilot-candidates.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

export interface DraftContext {
  readonly id: string;
  readonly version: number;
  readonly kind: DraftKind;
  readonly provenance: DraftProvenance;
  readonly createdAt: string;
  readonly repo: string | null;
  readonly payload: DraftPayload;
  /** The hint a label or an outcome is about: how it arrived, when. */
  readonly channel: string | null;
  readonly deliveredAt: string | null;
  /** What the hint pointed at, on this repo only, and whose work it was. */
  readonly pointedTitle: string | null;
  readonly sourceName: string | null;
  /** A pin's surface, for a break or an ok. */
  readonly pinSurface: string | null;
}

export interface ConfirmPageView {
  readonly fingerprint: string;
  readonly drafts: readonly DraftContext[];
}

type DeliveryRow = {
  readonly channel: string;
  readonly delivered_at: string | Date;
  readonly title: string | null;
  readonly title_source: string | null;
  readonly owner_developer_id: string | null;
  readonly owner_branch: string | null;
  readonly source_name: string | null;
};

/**
 * The hint a draft is about: its channel and instant, and the pointed work —
 * on this repo only — with what the live-location projection needs to judge
 * its title: an opted-out owner's branch-derived title is withheld here as on
 * every other surface (services/live-location.ts, the label walk's rule).
 */
const deliveryContext = async (db: Db, draft: DraftRow): Promise<DeliveryRow | undefined> => {
  const deliveryId = String(draft.payload["deliveryId"] ?? "");
  const rows = await db.execute<DeliveryRow>(sql`
    SELECT hd.channel, hd.delivered_at, wc.title, wc.title_source,
      ws.developer_id AS owner_developer_id, ws.branch AS owner_branch,
      (SELECT d.name FROM agent_sessions src JOIN developers d ON d.id = src.developer_id
        WHERE src.repo = ${draft.repo} AND src.id = CASE WHEN hd.ref_kind = 'work_context'
          THEN (SELECT w.session_id FROM work_contexts w WHERE w.id = hd.ref_id)
          ELSE (SELECT c.author_session_id FROM claims c WHERE c.id = hd.ref_id) END) AS source_name
    FROM hint_deliveries hd
    LEFT JOIN work_contexts wc ON wc.id = (${POINTED_WORK_CONTEXT})
      AND EXISTS (SELECT 1 FROM agent_sessions owner WHERE owner.id = wc.session_id AND owner.repo = ${draft.repo})
    LEFT JOIN agent_sessions ws ON ws.id = wc.session_id
    WHERE hd.id = ${deliveryId}`);
  return rows.rows[0];
};

/** The pointed title as this viewer may see it. */
const visibleTitle = (hidden: HiddenLocations, draft: DraftRow, delivery: DeliveryRow): string | null => {
  if (delivery.owner_developer_id === null) {
    return delivery.title;
  }
  return projectRow(
    hidden,
    {
      developerId: delivery.owner_developer_id,
      titleFacts: { repo: draft.repo ?? "", branch: delivery.owner_branch, titleSource: titleSourceOf(delivery.title_source) },
    },
    { title: delivery.title },
  ).title;
};

const pinSurfaceOf = async (db: Db, draft: DraftRow): Promise<string | null> => {
  if (draft.kind === "pin") {
    return String(draft.payload["surface"] ?? "");
  }
  const rows = await db.execute<{ surface: string }>(sql`
    SELECT surface FROM pins WHERE id = ${String(draft.payload["pinId"] ?? "")}`);
  return rows.rows[0]?.surface ?? null;
};

const contextOf = async (db: Db, hidden: HiddenLocations, draft: DraftRow): Promise<DraftContext> => {
  const base = {
    id: draft.id,
    version: draft.version,
    kind: draft.kind,
    provenance: draft.provenance,
    createdAt: draft.createdAt.toISOString(),
    repo: draft.repo,
    payload: draft.payload,
  };
  const none = { channel: null, deliveredAt: null, pointedTitle: null, sourceName: null, pinSurface: null };
  if (draft.kind === "label" || draft.kind === "outcome") {
    const delivery = await deliveryContext(db, draft);
    return {
      ...base,
      ...none,
      channel: delivery?.channel ?? null,
      deliveredAt: delivery === undefined ? null : new Date(delivery.delivered_at).toISOString(),
      pointedTitle: delivery === undefined ? null : visibleTitle(hidden, draft, delivery),
      sourceName: delivery?.source_name ?? null,
    };
  }
  if (draft.kind === "pin" || draft.kind === "pin_broke" || draft.kind === "pin_ok") {
    return { ...base, ...none, pinSurface: await pinSurfaceOf(db, draft) };
  }
  return { ...base, ...none };
};

/**
 * THE KINDS /ui/confirm SHOWS — its scope (§6): a batch it forms covers these
 * and nothing else, so a draft of a kind another page shows never invalidates
 * it. Today every kind; a later page with its own kinds takes its own scope.
 */
export const CONFIRM_PAGE_SCOPE: readonly DraftKind[] = DRAFT_KINDS;

/** The caller's pending drafts in the page's scope, with their context, and the fingerprint of exactly that set. */
export const readConfirmPage = async (
  deps: { readonly db: Db; readonly now: Clock },
  developerId: string,
): Promise<ConfirmPageView> => {
  const drafts = await readPendingDrafts(deps, developerId, { scope: CONFIRM_PAGE_SCOPE });
  const hidden = await locationHiddenFrom(deps.db, developerId);
  return {
    fingerprint: pendingFingerprint(drafts),
    drafts: await Promise.all(drafts.map((draft) => contextOf(deps.db, hidden, draft))),
  };
};
