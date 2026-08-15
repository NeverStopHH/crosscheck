/** @jsxImportSource hono/jsx */
/**
 * /ui/login — the only unauthenticated page. The form posts the developer's
 * API key once; the key is exchanged for a signed cookie and never rendered,
 * echoed, or stored. The failure message is generic on purpose: it must not
 * confirm which part of a guessed key was wrong.
 */
import type { FC } from "hono/jsx";

import { Layout } from "../layout.tsx";

interface LoginPageProps {
  /** Renderer-owned sentence — never derived from the submitted key. */
  readonly error?: string | undefined;
}

export const LoginPage: FC<LoginPageProps> = ({ error }) => (
  <Layout title="Sign in">
    <div class="card login-card">
      <h1>crosscheck</h1>
      <p class="notice">
        Sign in with your developer API key. You received it from{" "}
        <code>crosscheck invite</code>; it never leaves this hub.
      </p>
      {error === undefined ? null : <p class="error">{error}</p>}
      <form method="post" action="/ui/login">
        <label for="apiKey">API key</label>
        <input id="apiKey" name="apiKey" type="password" autocomplete="off" />
        <button type="submit">Sign in</button>
      </form>
    </div>
  </Layout>
);
