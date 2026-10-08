import { describe, expect, test } from "bun:test";

import { DEFAULT_DENYLIST, isDenied, resolveDenylist } from "../src/index.ts";
import { isDeniedUnlessAuthoritative } from "../src/capture/denylist.ts";

describe("denylist", () => {
  test("filters lockfiles, build output and generated clients", () => {
    // Arrange
    const denied = [
      "bun.lock",
      "package-lock.json",
      "dist/x.js",
      "packages/api-client/src/Api.generated.ts",
      "node_modules/zod/index.js",
      "assets/logo.png",
      ".env.local",
      "coverage/lcov.info",
    ];

    // Act & Assert
    for (const path of denied) {
      expect(isDenied(path, DEFAULT_DENYLIST)).toBe(true);
    }
  });

  test("filters credential files by name, wherever they sit (review M6)", () => {
    // Arrange: what the git lane's untracked and committed halves would otherwise send as paths
    const denied = [
      ".netrc",
      ".npmrc",
      "deploy/id_ed25519",
      "id_rsa",
      "keys/id_rsa.pub",
      "keys/prod.p12",
      "certs/client.pfx",
      "android/release.keystore",
      "config/credentials.json",
      "gcp/ci-credentials.json",
      "secrets/service-account.json",
      "secrets/my-service-account-key.json",
      "home/.aws/config",
      "home/.ssh/known_hosts",
      "certs/server.pem",
      "certs/tls.key",
    ];

    // Act & Assert
    for (const path of denied) {
      expect({ path, denied: isDenied(path, DEFAULT_DENYLIST) }).toEqual({ path, denied: true });
    }
  });

  test("no longer drops what may be hand-maintained or authoritative — the generated-target rule decides those", () => {
    // A hand-kept generated/ directory, a generator's own *.gen.* input, and
    // protobuf bindings: each now reaches capture, where the rule keeps it as
    // a target and suppresses only what is mechanically generated and
    // non-authoritative (capture/generated.ts).
    for (const path of [
      "packages/api/generated/client.ts",
      "packages/api-client/src/Api.gen.ts",
      "gen/go/messages.pb.go",
      "proto/messages_pb2.py",
    ]) {
      expect(isDenied(path, DEFAULT_DENYLIST), path).toBe(false);
    }
  });

  test("a path the repo declares authoritative passes the generated-output entries and no other", () => {
    // Arrange: the defaults, and a declared-authoritative file under each kind of rule.
    const declared = true;

    // Act & Assert: lockfiles, dist/ and *.generated.* are generated output.
    expect(isDeniedUnlessAuthoritative("clients/dist/api.js", DEFAULT_DENYLIST, declared)).toBe(false);
    expect(isDeniedUnlessAuthoritative("apps/x/yarn.lock", DEFAULT_DENYLIST, declared)).toBe(false);
    expect(isDeniedUnlessAuthoritative("clients/api.generated.ts", DEFAULT_DENYLIST, declared)).toBe(false);
    // Dependencies and secrets stay dropped whatever the repo declares.
    expect(isDeniedUnlessAuthoritative("clients/node_modules/x/dist/y.js", DEFAULT_DENYLIST, declared)).toBe(true);
    expect(isDeniedUnlessAuthoritative("clients/.env.production", DEFAULT_DENYLIST, declared)).toBe(true);
    // Undeclared, generated output is dropped as before.
    expect(isDeniedUnlessAuthoritative("clients/dist/api.js", DEFAULT_DENYLIST, false)).toBe(true);
  });

  test("keeps ordinary source files", () => {
    // Arrange
    const kept = [
      "src/a.ts",
      "src/api/handler.ts",
      "docs/DESIGN.md",
    ];

    // Act & Assert
    for (const path of kept) {
      expect(isDenied(path, DEFAULT_DENYLIST)).toBe(false);
    }
  });

  test("extend mode adds to the defaults", () => {
    // Arrange
    const patterns = resolveDenylist({ mode: "extend", patterns: ["**/*.sql"] });

    // Act & Assert
    expect(isDenied("db/seed.sql", patterns)).toBe(true);
    expect(isDenied("bun.lock", patterns)).toBe(true);
  });

  test("replace mode honours only the configured patterns", () => {
    // Arrange
    const patterns = resolveDenylist({
      mode: "replace",
      patterns: ["**/*.sql"],
    });

    // Act & Assert
    expect(isDenied("db/seed.sql", patterns)).toBe(true);
    expect(isDenied("bun.lock", patterns)).toBe(false);
  });
});
