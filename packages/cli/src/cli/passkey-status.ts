/**
 * ENROLMENT ANNOUNCEMENTS on `crosscheck status` and `doctor` (1.0 spec 04a
 * §4.3, PK-10).
 *
 * The hub cannot tell a passkey on Touch ID from one a program emulates, so a
 * passkey nobody expected is the one way an agent could plant an authority.
 * The cool-off holds it powerless for a day; THIS is how a person learns of
 * it inside that day — in the commands they already run.
 *
 * TWO REGISTERS. `status` names who, which device and which authenticator,
 * because a person must recognise the enrolment to judge it; those are other
 * people's words, so they go through `bareUntrusted`. `doctor` counts and
 * points at `status`, because doctor prints no names (its registration in
 * render-surfaces.ts promises counts). The hub URL is the local config's.
 */
import { formatAge } from "@crosscheck/connector-core/briefing/render.ts";
import { bareUntrusted } from "@crosscheck/connector-core/briefing/sanitize.ts";
import type { PasskeyAnnouncements } from "@crosscheck/connector-core/http/hub.ts";

import type { Check } from "./doctor.ts";

type Enrolment = PasskeyAnnouncements["enrolments"][number];

const passkeysPage = (hubUrl: string): string => `${hubUrl.replace(/\/+$/, "")}/ui/passkeys`;

const ageOf = (iso: string, now: Date): string => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "at an unreadable time" : `${formatAge(now.getTime() - ms)} ago`;
};

const enrolmentLine = (enrolment: Enrolment, hubUrl: string, now: Date): string => {
  const who =
    enrolment.developerName === "" ? "a developer this hub did not name" : bareUntrusted(enrolment.developerName);
  const head = `passkey enrolled for ${who}: ${bareUntrusted(enrolment.label)} (${bareUntrusted(
    enrolment.authenticator,
  )}), ${ageOf(enrolment.createdAt, now)}`;
  if (enrolment.revoked) {
    return `${head} — revoked`;
  }
  return enrolment.coolingOff
    ? `${head} — can approve waivers from ${enrolment.usableFrom}; not expected? revoke it at ${passkeysPage(hubUrl)}`
    : `${head} — can approve waivers now`;
};

/** `crosscheck status`: one line per recent enrolment, and the hub-wide gap if there is one. */
export const passkeyStatusLines = (
  view: PasskeyAnnouncements | null,
  hubUrl: string,
  now: Date,
): readonly string[] => {
  if (view === null) {
    // UNKNOWN, NEVER "NONE": a missing line would read as "nothing enrolled",
    // which is the one reading that could hide a planted passkey.
    return ["passkeys: unknown — the hub did not answer, so an enrolment would not show here"];
  }
  return [
    ...view.enrolments.map((enrolment) => enrolmentLine(enrolment, hubUrl, now)),
    ...(view.usablePasskeys === 0
      ? [
          `passkeys: no passkey on this hub can approve a waiver yet — a protected conflict cannot be waived until somebody enrols one at ${passkeysPage(hubUrl)}`,
        ]
      : []),
  ];
};

/** `crosscheck doctor`: counts only, and a WARN while any enrolment is still cooling off. */
export const passkeyDoctorCheck = (view: PasskeyAnnouncements | null, hubUrl: string): Check => {
  if (view === null) {
    return { level: "PASS", name: "passkeys", detail: "not measured — the hub did not answer" };
  }
  const cooling = view.enrolments.filter((enrolment) => enrolment.coolingOff && !enrolment.revoked).length;
  if (cooling > 0) {
    return {
      level: "WARN",
      name: "passkeys",
      detail: `${String(cooling)} passkey enrolment${cooling === 1 ? " is" : "s are"} still cooling off — run crosscheck status to see whose, and revoke any nobody expected at ${passkeysPage(hubUrl)}`,
    };
  }
  return {
    level: "PASS",
    name: "passkeys",
    detail: `${String(view.usablePasskeys)} can approve waivers on this hub; no enrolment is cooling off`,
  };
};
