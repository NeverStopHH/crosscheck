/**
 * ONE SENTENCE PER WAIVER REFUSAL, shared by the api route an agent's request
 * meets and the web page a person approves on (1.0 spec 04a §6).
 *
 * The services return an enum and never write prose; this map is where every
 * refusal a person reads was written on purpose. Two keep the shape 04
 * chose: a waiver or request in another repo answers the same as one that
 * does not exist, because telling a caller that something EXISTS somewhere
 * they cannot see is itself a disclosure.
 */
import type { WaiverRequestRefusal } from "../services/waiver-requests.ts";

export const WAIVER_REQUEST_SENTENCE: Record<WaiverRequestRefusal, string> = {
  unknown_pin: "no pin with that id exists on this repo",
  wrong_repo: "that pin belongs to another repo",
  stale_version:
    "that pin has moved to a new version since — ask again against the version it is at now",
  expiry_in_the_past: "that expiry has already passed — the waiver would be closed on arrival",
  expiry_beyond_ceiling:
    "that expiry is further out than a waiver may reach; ask for a shorter one, and ask again if it is still needed",
  already_requested:
    "a request for this fence is already waiting for a person; withdraw it first if its terms are wrong",
  unknown_request: "no waiver request with that id exists",
  not_requester: "only the developer who asked can withdraw a request",
  not_pending: "that request has already been answered, withdrawn, or has lapsed",
  expiry_beyond_request:
    "an approval may shorten the asked-for expiry, never lengthen it — ask again for longer",
  unknown_waiver: "no waiver with that id exists on this repo",
  not_a_grant: "that row is a revocation, not a grant",
  already_revoked: "that waiver has already been revoked",
  not_live: "that waiver is no longer holding the fence open, so there is nothing to amend",
};
