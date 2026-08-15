/** @jsxImportSource hono/jsx */
/**
 * /ui/members — hub members with presence state (task item 5). Presence
 * filtering happened hub-side (services/members.ts); this component only
 * renders what the service allowed, so it CANNOT leak an opted-out
 * member's activity — the data never arrives.
 */
import type { FC } from "hono/jsx";

import { UI_MAX_LABEL_CHARS } from "../constants.ts";
import { capped, formatUiAge } from "../format.ts";
import { Layout } from "../layout.tsx";
import type { ViewerChrome } from "../layout.tsx";
import type { MemberEntry } from "../../services/members.ts";

const MemberRow: FC<{ readonly member: MemberEntry; readonly nowMs: number }> = ({
  member,
  nowMs,
}) => (
  <li class="member">
    <strong>{capped(member.name, UI_MAX_LABEL_CHARS)}</strong>
    {member.isSelf ? <span class="meta"> (you)</span> : null}{" "}
    {member.presence === null ? null : (
      <span class="label presence">
        active · {capped(member.presence.status, UI_MAX_LABEL_CHARS)} ·{" "}
        {capped(member.presence.branch, UI_MAX_LABEL_CHARS)}
      </span>
    )}{" "}
    {member.isSelfOptedOut ? (
      <span class="notice">presence hidden from teammates</span>
    ) : null}{" "}
    <span class="meta">
      joined {formatUiAge(Math.max(0, nowMs - Date.parse(member.joinedAt)))}
    </span>
  </li>
);

interface MembersPageProps {
  readonly viewer: ViewerChrome;
  readonly members: readonly MemberEntry[];
  readonly nowMs: number;
}

export const MembersPage: FC<MembersPageProps> = ({
  viewer,
  members,
  nowMs,
}) => (
  <Layout title="Members" viewer={viewer}>
    <h1>Members</h1>
    <ul class="plain">
      {members.map((member) => (
        <MemberRow member={member} nowMs={nowMs} />
      ))}
    </ul>
    <p class="notice">
      Everyone holding a key to this hub is listed. Live presence honors each
      member's opt-out; opting out hides activity, never membership.
    </p>
  </Layout>
);
