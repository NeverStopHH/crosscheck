/** @jsxImportSource hono/jsx */
/**
 * What the two passkey pages share (1.0 spec 04a §5): the status line the
 * ceremony script writes into, the session-bound CSRF token it sends as a
 * header, and the script tag. Same-origin script only — the page's CSP
 * (`UI_PASSKEY_CSP`) admits nothing else.
 */
import type { FC } from "hono/jsx";

export const PASSKEY_SCRIPT_PATH = "/ui/passkey.js";

export const CeremonyChrome: FC<{ readonly csrfToken: string }> = ({ csrfToken }) => (
  <>
    <p id="ceremony-status" class="notice" role="status" aria-live="polite"></p>
    <div id="crosscheck-csrf" data-token={csrfToken} hidden></div>
    <script src={PASSKEY_SCRIPT_PATH} defer></script>
  </>
);

/** Shown instead of any ceremony when the hub was configured with no origin (04a §7). */
export const NoOriginNotice: FC = () => (
  <div class="card">
    <p>
      This hub accepts passkeys at no address. Set CROSSCHECK_WEBAUTHN_ORIGINS
      to the https address members open the hub at (for example the one
      tailscale serve gives it) and restart the hub.
    </p>
  </div>
);
