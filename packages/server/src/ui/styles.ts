/**
 * The whole stylesheet, served from the package at /ui/styles.css — the only
 * style source the CSP allows (style-src 'self'; nothing inline, no CDN).
 * System fonts only: no external asset may load on this surface.
 */
export const UI_STYLESHEET = `
:root {
  --bg: #f6f7f9;
  --card: #ffffff;
  --ink: #1c2733;
  --muted: #5b6b7b;
  --line: #dde3ea;
  --accent: #0b6e4f;
  --danger: #a03030;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 46rem; margin: 0 auto; padding: 1rem; }
header.site {
  background: var(--card);
  border-bottom: 1px solid var(--line);
  padding: 0.6rem 1rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
header.site .brand { font-weight: 700; }
header.site nav { display: flex; gap: 0.8rem; }
header.site .viewer { margin-left: auto; display: flex; gap: 0.6rem; align-items: center; color: var(--muted); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h1 { font-size: 1.25rem; }
h2 { font-size: 1.05rem; }
ul.plain { list-style: none; padding: 0; margin: 0; }
li.entry, li.member, li.artifact, div.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0.6rem 0.8rem;
  margin: 0 0 0.5rem 0;
}
.meta { color: var(--muted); font-size: 0.85rem; }
.label {
  display: inline-block;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0 0.35rem;
  font-size: 0.8rem;
  color: var(--muted);
  background: var(--bg);
}
.label.status-likely_root_cause { color: var(--accent); border-color: var(--accent); }
.label.provenance-derived { font-style: italic; }
blockquote.body {
  margin: 0.4rem 0 0 0;
  padding: 0.3rem 0.6rem;
  border-left: 3px solid var(--line);
  color: var(--ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
form.inline { display: inline; }
button {
  font: inherit;
  padding: 0.25rem 0.7rem;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--card);
  cursor: pointer;
}
button.approve { border-color: var(--accent); color: var(--accent); }
button.revoke, button.logout { color: var(--danger); }
.notice { color: var(--muted); font-size: 0.9rem; }
.error { color: var(--danger); }
.login-card { max-width: 24rem; margin: 4rem auto; }
input[type="password"] {
  width: 100%;
  font: inherit;
  padding: 0.4rem;
  border: 1px solid var(--line);
  border-radius: 5px;
  margin: 0.4rem 0 0.8rem 0;
}
pre.artifact-content {
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 0.5rem;
  overflow-x: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
`;
