/**
 * A TRANSPORT-ONLY ssh HostName override must NOT fork the repo identity.
 *
 * The regression (found reviewing the F5 ssh-alias fix as the Asia teammate):
 * dbbc944 resolves EVERY ssh host through `ssh -G`, so a config that only
 * changes the TRANSPORT of a real forge host — not its identity — now rewrites
 * the repo id and silently un-matches teammates. The two configs that do this
 * are the vendors' OWN documented firewall workarounds, and they are exactly
 * what a teammate behind a port-22-blocking firewall (the remote-onboarding
 * scenario this whole branch exists for) is told to use:
 *
 *   GitHub  (docs: "Using SSH over the HTTPS port")
 *     Host github.com
 *       HostName ssh.github.com
 *       Port 443
 *
 *   GitLab  (docs: "Use SSH on port 443")
 *     Host gitlab.com
 *       HostName altssh.gitlab.com
 *       Port 443
 *
 * Before dbbc944 both produced `github.com/acme/api` / `gitlab.com/acme/api`
 * — matching every plain teammate. After it they produce
 * `ssh.github.com/acme/api` / `altssh.gitlab.com/acme/api`, and the hub sees
 * two repos: the SAME class of silent fork F5 set out to KILL, re-created for a
 * far commoner, firewall-relevant config than the multi-account alias it fixed.
 *
 * The distinguishing fact, and the fix: a transport override resolves the host
 * to a SUBDOMAIN of itself (ssh.github.com is under github.com), whereas a
 * genuine alias (`github.com-toandiep`) resolves to an unrelated host. So a
 * resolved host that is the literal host or a subdomain of it is transport, not
 * identity, and the literal host is kept. The alias fix is unaffected —
 * pinned here alongside so the two cannot drift apart.
 *
 * Deterministic: the ssh config is an injected resolver, exactly as
 * repo-ssh-alias.test.ts does it — no dependency on this machine's ~/.ssh.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { resolveRepoIdentity } from "../src/git/repo-identity.ts";
import { makeRepo } from "./helpers.ts";

/** GitHub's documented port-443 workaround, as an injected `ssh -G` resolver. */
const githubOverHttps = async (host: string): Promise<string | null> =>
  host === "github.com" ? "ssh.github.com" : host;

/** GitLab's documented port-443 workaround. */
const gitlabOverHttps = async (host: string): Promise<string | null> =>
  host === "gitlab.com" ? "altssh.gitlab.com" : host;

/** The multi-account alias F5 fixed — must still canonicalize. */
const aliasResolver = async (host: string): Promise<string | null> =>
  host === "github.com-toandiep" ? "github.com" : host;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

describe("a transport-only HostName override keeps the canonical identity", () => {
  test("GitHub's ssh.github.com:443 firewall workaround stays github.com", async () => {
    // Arrange: the remote everyone types, the ssh config a firewalled teammate runs
    const repo = await makeRepo("gh-443", {
      remote: "git@github.com:acme/api.git",
    });
    paths.push(repo);

    // Act
    const identity = await resolveRepoIdentity(repo, githubOverHttps);

    // Assert: ONE repo on the hub with every plain teammate, not two
    expect(identity?.repoId).toBe("github.com/acme/api");
  });

  test("GitLab's altssh.gitlab.com:443 firewall workaround stays gitlab.com", async () => {
    // Arrange
    const repo = await makeRepo("gl-443", {
      remote: "git@gitlab.com:acme/api.git",
    });
    paths.push(repo);

    // Act
    const identity = await resolveRepoIdentity(repo, gitlabOverHttps);

    // Assert
    expect(identity?.repoId).toBe("gitlab.com/acme/api");
  });

  test("a genuine multi-account alias STILL canonicalizes (F5 preserved)", async () => {
    // Arrange: the incident F5 fixed — the guard must not undo it
    const repo = await makeRepo("gh-alias", {
      remote: "git@github.com-toandiep:acme/api.git",
    });
    paths.push(repo);

    // Act
    const identity = await resolveRepoIdentity(repo, aliasResolver);

    // Assert: alias collapses to the canonical host, as F5 intends
    expect(identity?.repoId).toBe("github.com/acme/api");
  });
});
