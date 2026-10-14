/**
 * What the bootstrap recorded about this database when it first ran
 * (db/bootstrap.sql `hub_install`): where the hub listens when
 * CROSSCHECK_LISTEN is unset. Read once at boot, by `startServer`.
 */
import { sql } from "drizzle-orm";

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

/**
 * WHETHER THIS DATABASE HOLDS MEMBERS FROM BEFORE IT WAS CREATED (review of
 * the hub hardening, L5): a developer whose `created_at` predates the
 * install record. Only a dump/restore or a migration into a fresh data dir
 * makes one, because the bootstrap writes `hub_install` before any row can
 * arrive. Such a hub was recorded `loopback` although its teammates reached
 * the old one over the network, so the boot warns rather than leave them at
 * "connection refused". A file-level copy keeps its old record and never
 * gets here.
 */
export const holdsMembersFromBeforeInstall = async (db: Db): Promise<boolean> => {
  const result = await db.execute<{ readonly restored: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM developers, hub_install
      WHERE developers.created_at < hub_install.recorded_at
    ) AS restored`);
  return result.rows[0]?.restored === true;
};
