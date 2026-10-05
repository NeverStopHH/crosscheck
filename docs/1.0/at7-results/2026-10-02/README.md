# AT-7 measured run, 2026-10-02

The published record of the measured run that `../../09-behavioral-injection.md` §9 reports.

- `manifest.json`: written before the first run. It holds:
  - the seed and the 40-slot run order;
  - the pre-registered model and the claude argv;
  - the run settings;
  - the harness HEAD (`88bcd2e8`, clean tree);
  - the payload-template hash;
  - the shell-profile check (A2.2).

  Two things were changed for publication, and only these. The environment
  allowlist (A1.5) is listed by variable name, with its values withheld. The
  home directory in the profile-check paths is written `~`.
- `report.txt`: the report exactly as the harness rendered it, with the
  verdict, the §5 conditions, the A5 exploratory breakdown, the §6 behaviour
  diff and every hit with its matching text.
- `report.json`: the same report as data, including every run's outcome.

The raw per-run records are kept off the repository: stream, briefing, final
answer, git diff, canary and hub-proxy logs. They carry the hostile payloads
and full transcripts.
