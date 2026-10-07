/**
 * What the bootstrap recorded about this database when it first ran
 * (db/bootstrap.sql `hub_install`): where the hub listens when
 * CROSSCHECK_LISTEN is unset. Read once at boot, by `startServer`.
 */
import { hubInstall } from "../db/schema.ts";
import type { HubListenDefault } from "../db/schema.ts";
import type { Db } from "../db/client.ts";

/**
 * The recorded default. The bootstrap always writes the row before anything
 * else, so a missing one means the table was emptied by hand; that reads as
 * the older behaviour, which is what such a hub had before the row existed,
 * and it is the one that gets warned about.
 */
export const readListenDefault = async (db: Db): Promise<HubListenDefault> => {
  const rows = await db.select({ listenDefault: hubInstall.listenDefault }).from(hubInstall).limit(1);
  return rows[0]?.listenDefault ?? "all_interfaces";
};
