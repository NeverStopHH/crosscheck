import { inArray, not, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";

import { CLOUD_AGENT_IDENTITIES } from "@crosscheck/schema";

const CLOUD_AGENT_EMAILS = CLOUD_AGENT_IDENTITIES.map(
  (identity) => identity.email,
);

/**
 * "THIS ADDRESS IS A CLOUD AGENT'S COMMIT IDENTITY" — the one spelling every
 * query that resolves an address to a developer asks it in. The same
 * lowercased equality against the same schema rows as `cloudAgentForEmail`,
 * which answers it for a value already in hand; a query cannot call that, so
 * this is its SQL form, built from the table rather than written out again.
 */
export const isCloudAgentEmail = (email: AnyColumn): SQL =>
  inArray(sql`lower(${email})`, CLOUD_AGENT_EMAILS);

/**
 * A `developer_emails` row an address may resolve a developer through.
 *
 * A HELD LINK IS INERT. The developers routes refuse to link a cloud agent's
 * commit identity (services/developers.ts CloudAgentRefused), but a hub can
 * hold one from before that, or written straight into the table. Honoured,
 * it would make every commit under that identity, by anyone, one developer's:
 * the absence listing would name them, the census would let a session of
 * theirs close the gap, and a landed change would be told to them as their
 * work. None of that is evidence the hub holds — git does not name who
 * started the cloud session — so every site that turns an address into a
 * developer asks this, and the row stays for an admin to remove
 * (services/absences.ts listLinkedCloudAgents reports it).
 */
export const resolvesToDeveloper = (email: AnyColumn): SQL =>
  not(isCloudAgentEmail(email));
