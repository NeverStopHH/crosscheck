import { describe, expect, test } from "bun:test";

import { getDiagnosis } from "../src/services/diagnosis.ts";
import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  jsonRequest,
  postRecords,
  recordEnvelope,
  registerTestSession,
  validClaimBody,
  validClaimEdgeBody,
  validWorkContextBody,
  WORK_CONTEXT_ID,
} from "./helpers.ts";
import type { HarnessWithSession, TestDeveloper } from "./helpers.ts";

const OTHER_REPO = "github.com/acme/web";
const OTHER_REPO_SESSION_ID = "ses_web";
const SECOND_DEV_SESSION_ID = "ses_can";
const LATER_ISO = "2026-07-24T10:30:00.000Z";
const REPO_QUERY = "/api/work-contexts?repo=github.com%2Facme%2Fapi";

interface WorkContextListEntry {
  readonly id: string;
  readonly title: string;
  readonly developerId: string;
  readonly developerName: string;
  readonly claimCount: number;
}

interface DiagnosisData {
  readonly workContext: {
    readonly id: string;
    readonly title: string;
    readonly description: string | null;
    readonly status: string;
  };
  readonly claims: {
    readonly id: string;
    readonly body: string;
    readonly dedupCount: number;
    readonly evidenceRefs: string[];
    readonly authorDeveloperId: string;
    readonly authorDeveloperName: string;
  }[];
  readonly edges: {
    readonly id: string;
    readonly fromClaimId: string;
    readonly toClaimId: string;
    readonly kind: string;
  }[];
  readonly externalClaims: {
    readonly id: string;
    readonly kind: string;
    readonly workContextId: string;
  }[];
  readonly truncated: boolean;
}

const addSecondDeveloper = async (
  setup: HarnessWithSession,
): Promise<TestDeveloper> =>
  addTestDeveloperWithSession(setup.harness, "Robin", "robin@example.com", {
    id: SECOND_DEV_SESSION_ID,
  });

const seedDiagnosisTree = async (setup: HarnessWithSession): Promise<void> => {
  const { harness, developer } = setup;
  await postRecords(harness, developer, {
    records: [
      recordEnvelope("work_context", validWorkContextBody()),
      recordEnvelope("claim", validClaimBody()),
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_02",
          kind: "root_cause",
          status: "likely_root_cause",
          body: "Signing key rotation misses the refresh path",
          evidenceRefs: ["clm_01"],
        }),
      ),
      recordEnvelope("claim_edge", validClaimEdgeBody()),
    ],
  });
};

describe("GET /api/work-contexts", () => {
  test("lists work contexts for a repo with claim counts, newest first", async () => {
    // Arrange: two contexts in the main repo, one in another repo
    const setup = await createHarnessWithSession();
    const { harness, developer } = setup;
    await seedDiagnosisTree(setup);
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: "wc_02",
          title: "Slow cube rebuild",
          createdAt: LATER_ISO,
        }),
      ),
    );
    await registerTestSession(harness, developer.apiKey, {
      id: OTHER_REPO_SESSION_ID,
      repo: OTHER_REPO,
    });
    await postRecords(
      harness,
      developer,
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: "wc_web",
          sessionId: OTHER_REPO_SESSION_ID,
          title: "Web build broken",
        }),
        { sessionId: OTHER_REPO_SESSION_ID },
      ),
    );

    // Act
    const response = await harness.app.request(
      REPO_QUERY,
      jsonRequest("GET", developer.apiKey),
    );

    // Assert
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { workContexts: WorkContextListEntry[] };
    };
    expect(body.data.workContexts.map((entry) => entry.id)).toEqual([
      "wc_02",
      WORK_CONTEXT_ID,
    ]);
    expect(body.data.workContexts[0]?.claimCount).toBe(0);
    expect(body.data.workContexts[1]?.claimCount).toBe(2);
  });

  test("carries the author's name so readers need no presence lookup", async () => {
    // Arrange: two developers, each with a work context on the same repo
    const setup = await createHarnessWithSession();
    await seedDiagnosisTree(setup);
    const second = await addSecondDeveloper(setup);
    await postRecords(
      setup.harness,
      second,
      recordEnvelope(
        "work_context",
        validWorkContextBody({
          id: "wc_robin",
          sessionId: SECOND_DEV_SESSION_ID,
          title: "Cube rebuild is slow",
        }),
        { sessionId: SECOND_DEV_SESSION_ID },
      ),
    );

    // Act
    const response = await setup.harness.app.request(
      REPO_QUERY,
      jsonRequest("GET", setup.developer.apiKey),
    );

    // Assert
    const body = (await response.json()) as {
      data: { workContexts: WorkContextListEntry[] };
    };
    const byId = new Map(
      body.data.workContexts.map((entry) => [entry.id, entry.developerName]),
    );
    expect(byId.get("wc_robin")).toBe("Robin");
    expect(byId.get(WORK_CONTEXT_ID)).toBe("Nick");
  });

  test("returns 401 without an api key", async () => {
    const { harness } = await createHarnessWithSession();

    const response = await harness.app.request(
      REPO_QUERY,
      jsonRequest("GET", null),
    );

    expect(response.status).toBe(401);
  });

  test("returns 400 when the repo query is missing", async () => {
    const { harness, developer } = await createHarnessWithSession();

    const response = await harness.app.request(
      "/api/work-contexts",
      jsonRequest("GET", developer.apiKey),
    );

    expect(response.status).toBe(400);
  });
});

describe("GET /api/work-contexts/:id/diagnosis", () => {
  test("returns the work context tree with claims and edges", async () => {
    // Arrange
    const setup = await createHarnessWithSession();
    await seedDiagnosisTree(setup);

    // Act
    const response = await setup.harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", setup.developer.apiKey),
    );

    // Assert
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: DiagnosisData };
    expect(body.data.workContext.id).toBe(WORK_CONTEXT_ID);
    expect(body.data.workContext.title).toBe("Login 500s on staging");
    expect(body.data.claims).toHaveLength(2);
    const rootCause = body.data.claims.find((claim) => claim.id === "clm_02");
    expect(rootCause?.evidenceRefs).toEqual(["clm_01"]);
    expect(rootCause?.dedupCount).toBe(1);
    expect(body.data.edges).toHaveLength(1);
    expect(body.data.edges[0]?.fromClaimId).toBe("clm_02");
    expect(body.data.edges[0]?.toClaimId).toBe("clm_01");
    expect(body.data.edges[0]?.kind).toBe("supports");
    expect(body.data.externalClaims).toHaveLength(0);
    expect(body.data.truncated).toBe(false);
  });

  test("sets truncated when claim or edge limits are hit", async () => {
    // Arrange: the seeded tree holds 2 claims and 1 edge
    const setup = await createHarnessWithSession();
    await seedDiagnosisTree(setup);

    // Act: unit-level call with limits below the seeded tree size
    const diagnosis = await getDiagnosis(setup.harness.db, WORK_CONTEXT_ID, {
      maxClaims: 1,
      maxEdges: 1,
    });

    // Assert
    expect(diagnosis?.truncated).toBe(true);
    expect(diagnosis?.claims).toHaveLength(1);
    expect(diagnosis?.edges).toHaveLength(1);
  });

  test("includes cross-context edges with the foreign claim id and kind", async () => {
    // Arrange: a claim in another work context points into this tree
    const setup = await createHarnessWithSession();
    const { harness, developer } = setup;
    await seedDiagnosisTree(setup);
    await postRecords(harness, developer, {
      records: [
        recordEnvelope(
          "work_context",
          validWorkContextBody({ id: "wc_02", title: "Session store leak" }),
        ),
        recordEnvelope(
          "claim",
          validClaimBody({
            id: "clm_foreign",
            workContextId: "wc_02",
            kind: "hypothesis",
            body: "Session store leak is the deeper cause",
          }),
        ),
        recordEnvelope(
          "claim_edge",
          validClaimEdgeBody({
            id: "edge_cross",
            fromClaimId: "clm_foreign",
            toClaimId: "clm_02",
            kind: "deeper_cause_of",
          }),
        ),
      ],
    });

    // Act
    const response = await harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", developer.apiKey),
    );

    // Assert
    const body = (await response.json()) as { data: DiagnosisData };
    const crossEdge = body.data.edges.find((edge) => edge.id === "edge_cross");
    expect(crossEdge?.kind).toBe("deeper_cause_of");
    expect(body.data.externalClaims).toEqual([
      { id: "clm_foreign", kind: "hypothesis", workContextId: "wc_02" },
    ]);
  });

  test("returns 404 for an unknown work context", async () => {
    const { harness, developer } = await createHarnessWithSession();

    const response = await harness.app.request(
      "/api/work-contexts/wc_ghost/diagnosis",
      jsonRequest("GET", developer.apiKey),
    );

    expect(response.status).toBe(404);
  });

  /**
   * Author is a normative trust label (DESIGN.md §4), and a tree carrying a
   * claim from a SECOND developer is the shape that needs it: `extend_diagnosis`
   * puts B's claim inside A's context, so `workContexts.sessionId` — which names
   * the CREATING session and never moves — cannot answer who wrote a given
   * claim. Only `claims.authorSessionId` can, and it is an opaque `cc_<uuid>`
   * that no reader can turn into a person.
   */
  test("labels every claim with the developer who wrote it, not just a session id", async () => {
    // Arrange: A's tree, then B adds a claim INTO A's work context
    const setup = await createHarnessWithSession();
    await seedDiagnosisTree(setup);
    const second = await addSecondDeveloper(setup);
    await postRecords(
      setup.harness,
      second,
      recordEnvelope(
        "claim",
        validClaimBody({
          id: "clm_robin",
          authorSessionId: SECOND_DEV_SESSION_ID,
          kind: "hypothesis",
          body: "The refresh path never reloads the rotated key",
        }),
        { sessionId: SECOND_DEV_SESSION_ID },
      ),
    );

    // Act
    const response = await setup.harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", setup.developer.apiKey),
    );

    // Assert: both authors are named, and the ids are the developers' own
    const body = (await response.json()) as { data: DiagnosisData };
    const byId = new Map(body.data.claims.map((claim) => [claim.id, claim]));
    expect(byId.get("clm_01")?.authorDeveloperName).toBe("Nick");
    expect(byId.get("clm_01")?.authorDeveloperId).toBe(
      setup.developer.developerId,
    );
    expect(byId.get("clm_robin")?.authorDeveloperName).toBe("Robin");
    expect(byId.get("clm_robin")?.authorDeveloperId).toBe(second.developerId);
  });
});

describe("cross-developer read access (DESIGN.md §2.1: one hub = one trust space)", () => {
  test("developer B lists developer A's work contexts", async () => {
    // Arrange: A's tree, then B joins the hub with an own session
    const setup = await createHarnessWithSession();
    await seedDiagnosisTree(setup);
    const second = await addSecondDeveloper(setup);

    // Act: B lists the repo's work contexts
    const response = await setup.harness.app.request(
      REPO_QUERY,
      jsonRequest("GET", second.apiKey),
    );

    // Assert: A's context is team-visible with A's authorship intact
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { workContexts: WorkContextListEntry[] };
    };
    const entry = body.data.workContexts.find(
      (candidate) => candidate.id === WORK_CONTEXT_ID,
    );
    expect(entry?.claimCount).toBe(2);
    expect(entry?.developerId).toBe(setup.developer.developerId);
  });

  test("developer B reads developer A's full diagnosis tree", async () => {
    // Arrange
    const setup = await createHarnessWithSession();
    await seedDiagnosisTree(setup);
    const second = await addSecondDeveloper(setup);

    // Act
    const response = await setup.harness.app.request(
      `/api/work-contexts/${WORK_CONTEXT_ID}/diagnosis`,
      jsonRequest("GET", second.apiKey),
    );

    // Assert: full tree, not a redacted view
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: DiagnosisData };
    expect(body.data.workContext.id).toBe(WORK_CONTEXT_ID);
    expect(body.data.claims).toHaveLength(2);
    expect(body.data.edges).toHaveLength(1);
  });
});
