/**
 * The age every briefing and hint line prints: "30s", "12m", "5h", "3d" —
 * the caller adds " ago". Its own module so the render-layer modules that
 * briefing/render.ts imports can print ages too without an import cycle
 * (briefing/landed-notices.ts); render.ts re-exports it for everyone else.
 */
import {
  AGE_HOURS_BEFORE_DAYS,
  MINUTES_PER_HOUR,
  MS_PER_SECOND,
  SECONDS_PER_MINUTE,
} from "../constants.ts";

export const formatAge = (ageMs: number): string => {
  const seconds = Math.max(0, Math.floor(ageMs / MS_PER_SECOND));
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < AGE_HOURS_BEFORE_DAYS) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
};
