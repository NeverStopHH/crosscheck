/**
 * The coarse age a state line in `doctor` and `status` prints: "3m ago",
 * "2h ago", "4d ago". Coarse and honest — the exact minute of a nightly run
 * or a background fetch helps nobody.
 *
 * OUTSIDE THE RENDER LAYER ON PURPOSE. The briefing's `formatAge` lives in a
 * render module, and a CLI module that imports one becomes a render surface
 * that must carry the untrusted-content fixtures (render-surfaces.ts). A line
 * built only from Crosscheck's own words and times needs none of that.
 */
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

export const ageOf = (iso: string, now: Date): string => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return "at an unreadable time";
  }
  const minutes = Math.max(
    0,
    Math.floor((now.getTime() - ms) / (MS_PER_SECOND * SECONDS_PER_MINUTE)),
  );
  if (minutes < MINUTES_PER_HOUR) {
    return `${String(minutes)}m ago`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  return hours < HOURS_PER_DAY
    ? `${String(hours)}h ago`
    : `${String(Math.floor(hours / HOURS_PER_DAY))}d ago`;
};
