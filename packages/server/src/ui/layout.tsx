/** @jsxImportSource hono/jsx */
/**
 * The shared page shell for every /ui page.
 *
 * ESCAPING DISCIPLINE (task item 4 — the web equivalent of the connector's
 * render.ts): every untrusted string on this surface reaches the page as a
 * JSX interpolation, which hono/jsx HTML-escapes by construction — element
 * text and attribute values both. Nothing anywhere in src/ui passes
 * untrusted text through `raw()` or `dangerouslySetInnerHTML`; the ONE
 * `raw()` below carries the constant doctype and nothing else. URLs are
 * renderer-built (format.ts percent-encodes ids); attribute values are
 * always quoted by the renderer.
 */
import { raw } from "hono/html";
import type { FC, PropsWithChildren } from "hono/jsx";

/** What the shell needs to render the nav + logout form for a signed-in viewer. */
export interface ViewerChrome {
  readonly name: string;
  readonly csrfToken: string;
}

interface LayoutProps {
  readonly title: string;
  /** Undefined on the login page — no nav, no logout, no CSRF. */
  readonly viewer?: ViewerChrome | undefined;
  /** Set on the feed for live-ish updates; absent everywhere else. */
  readonly refreshSeconds?: number | undefined;
}

const STYLESHEET_HREF = "/ui/styles.css";

export const Layout: FC<PropsWithChildren<LayoutProps>> = ({
  title,
  viewer,
  refreshSeconds,
  children,
}) => (
  <>
    {raw("<!DOCTYPE html>")}
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {refreshSeconds === undefined ? null : (
          <meta http-equiv="refresh" content={String(refreshSeconds)} />
        )}
        <title>{title} · crosscheck</title>
        <link rel="stylesheet" href={STYLESHEET_HREF} />
      </head>
      <body>
        {viewer === undefined ? null : (
          <header class="site">
            <span class="brand">crosscheck</span>
            <nav>
              <a href="/ui/feed">Feed</a>
              <a href="/ui/members">Members</a>
              <a href="/ui/approvals">Approvals</a>
            </nav>
            <span class="viewer">
              {viewer.name}
              <form class="inline" method="post" action="/ui/logout">
                <input type="hidden" name="_csrf" value={viewer.csrfToken} />
                <button type="submit" class="logout">
                  Log out
                </button>
              </form>
            </span>
          </header>
        )}
        <main>{children}</main>
      </body>
    </html>
  </>
);
