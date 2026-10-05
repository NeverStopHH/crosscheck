/**
 * A DELIVERY THIS MACHINE STILL HOLDS (1.0 spec 07 §13.10, review #14).
 *
 * A prompt hint, a tripwire ask or a briefing pointer books its delivery into
 * the spool, and the spool is sent after the next tool runs — a denied edit
 * runs no after-tool hook at all. So an outcome recorded right after the hint
 * names a delivery the hub has not seen yet, and the hub's honest answer, "no
 * hint with that id reached you", is false from where the reader sits: it
 * reached them; it has not reached the hub.
 *
 * Two halves, for both recorders (`mark_hint_outcome`, `crosscheck followed /
 * overrode`): send what is held first, bounded; and when the hub still does
 * not know the ref, look here before repeating its sentence.
 */
import type { HubContext } from "../http/client.ts";
import { flushSpool } from "./flush.ts";
import type { FlushInput } from "./flush.ts";
import { readSpoolLines } from "./files.ts";

const HINT_DELIVERY_KIND = "hint_delivery";

/**
 * Sends this repo's spooled records, bounded by `budgetMs`, in the name of a
 * live session — the hub ingests only what a live session sends. With no live
 * session nothing can be sent, and nothing is tried.
 */
export const sendHeldRecords = async (
  hub: HubContext,
  sender: FlushInput | null,
  budgetMs: number,
): Promise<void> => {
  if (sender === null) {
    return;
  }
  await flushSpool(hub, sender, budgetMs);
};

const deliveryRefs = (line: string): readonly string[] => {
  try {
    const parsed = JSON.parse(line) as { kind?: unknown; body?: { id?: unknown; refId?: unknown } };
    if (parsed.kind !== HINT_DELIVERY_KIND) {
      return [];
    }
    return [parsed.body?.id, parsed.body?.refId].filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
};

/**
 * Whether this machine's spool still holds an unsent delivery of `ref` — the
 * id the hint printed or the delivery's own id — or, with `ref` null, any
 * unsent delivery at all.
 */
export const holdsUnsentDelivery = async (hub: HubContext, ref: string | null): Promise<boolean> =>
  (await readSpoolLines(hub.home, hub.repoKey)).some((line) => {
    const refs = deliveryRefs(line);
    return ref === null ? refs.length > 0 : refs.includes(ref);
  });
