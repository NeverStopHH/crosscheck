/**
 * THE RUNNER'S OWN REPORT, READ STRUCTURALLY (spec 05 §3.4).
 *
 * Every fixture here is the shape `bun test --reporter=junit` wrote on
 * bun 1.3.13, measured over a probe file in a scratchpad — not a shape a
 * reader guessed. The facts that matter and are asserted below:
 *
 *   - the describe chain is present STRUCTURALLY as nested `<testsuite>`
 *     elements, outermost first and singly escaped, while `classname` is the
 *     same chain innermost-first AND double-escaped (`inner &amp;gt; outer`);
 *   - a top-level test sits directly under the FILE suite with `classname=""`;
 *   - a thrown error and a failed expectation both arrive as `<failure>`;
 *   - `<skipped />` marks a skipped test; `hostname` rides on every suite;
 *   - `time` is seconds, on the root and on every case.
 *
 * The parser reads the ancestry and never `classname`: a reversal silently
 * corrupts any describe name that legitimately contains `>`, which is the
 * second CI-6 case.
 */
import { describe, expect, test } from "bun:test";

import { parseJunit } from "../src/ci-report/junit.ts";
import type { JunitCase } from "../src/ci-report/junit.ts";

/** Verbatim bun 1.3.13 output over the probe (hostname and line kept). */
export const MEASURED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="7" assertions="5" failures="4" skipped="1" time="0.005208">
  <testsuite name="probe.test.ts" file="probe.test.ts" tests="7" assertions="5" failures="4" skipped="1" time="0" hostname="MacBook-Pro-von-Nick.local">
    <testcase name="top level green" classname="" time="0" file="probe.test.ts" line="3" assertions="1" />
    <testcase name="top level red" classname="" time="0.000138" file="probe.test.ts" line="7" assertions="1">
      <failure type="AssertionError" />
    </testcase>
    <testcase name="top level skipped" classname="" time="0" file="probe.test.ts" line="11" assertions="0">
      <skipped />
    </testcase>
    <testsuite name="outer" file="probe.test.ts" line="15" tests="3" assertions="3" failures="2" skipped="0" time="0" hostname="MacBook-Pro-von-Nick.local">
      <testsuite name="inner" file="probe.test.ts" line="16" tests="1" assertions="1" failures="1" skipped="0" time="0" hostname="MacBook-Pro-von-Nick.local">
        <testcase name="nested red" classname="inner &amp;gt; outer" time="0.0025" file="probe.test.ts" line="17" assertions="1">
          <failure type="AssertionError" />
        </testcase>
      </testsuite>
      <testcase name="dup name" classname="outer" time="0" file="probe.test.ts" line="21" assertions="1" />
      <testcase name="dup name" classname="outer" time="0" file="probe.test.ts" line="24" assertions="1">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
    <testsuite name="a &gt; b" file="probe.test.ts" line="29" tests="1" assertions="0" failures="1" skipped="0" time="0" hostname="MacBook-Pro-von-Nick.local">
      <testcase name="weird describe red" classname="a &amp;gt; b" time="0" file="probe.test.ts" line="30" assertions="0">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
  </testsuite>
</testsuites>
`;

const parsed = (xml: string) => {
  const result = parseJunit(xml);
  if (!result.ok) {
    throw new Error(`fixture did not parse: ${result.reason}`);
  }
  return result.run;
};

const caseNamed = (
  cases: readonly JunitCase[],
  name: string,
  index = 0,
): JunitCase => {
  const found = cases.filter((entry) => entry.name === name)[index];
  if (found === undefined) {
    throw new Error(`no case named ${name}`);
  }
  return found;
};

describe("the runner's totals are read from the root, as the runner counted them", () => {
  test("tests, failures, skipped and the duration in milliseconds", () => {
    // Act
    const run = parsed(MEASURED_XML);

    // Assert
    expect(run.tests).toBe(7);
    expect(run.failures).toBe(4);
    expect(run.skipped).toBe(1);
    // 0.005208 s, rounded to whole milliseconds.
    expect(run.durationMs).toBe(5);
    expect(run.cases).toHaveLength(7);
  });
});

describe("the describe chain comes from the <testsuite> ancestry, never from classname", () => {
  test("a nested test carries the chain OUTERMOST first", () => {
    const nested = caseNamed(parsed(MEASURED_XML).cases, "nested red");

    // classname said `inner &gt; outer`; the ancestry says outer, then inner.
    expect(nested.chain).toEqual(["outer", "inner"]);
    expect(nested.file).toBe("probe.test.ts");
    expect(nested.durationMs).toBe(3);
  });

  test("a top-level test has an EMPTY chain, not the file suite's name", () => {
    const top = caseNamed(parsed(MEASURED_XML).cases, "top level red");

    expect(top.chain).toEqual([]);
  });

  test("a describe named `a > b` round-trips as ONE segment (CI-6, second case)", () => {
    const weird = caseNamed(parsed(MEASURED_XML).cases, "weird describe red");

    expect(weird.chain).toEqual(["a > b"]);
  });
});

describe("status is read for PRESENCE of the marker element only", () => {
  test("a failed expectation and a thrown error are both `failed`", () => {
    const cases = parsed(MEASURED_XML).cases;

    expect(caseNamed(cases, "top level red").status).toBe("failed");
    expect(caseNamed(cases, "weird describe red").status).toBe("failed");
  });

  test("a self-closing testcase is `passed`", () => {
    expect(caseNamed(parsed(MEASURED_XML).cases, "top level green").status).toBe(
      "passed",
    );
  });

  test("<skipped /> is `skipped`, and stays a case rather than vanishing", () => {
    expect(caseNamed(parsed(MEASURED_XML).cases, "top level skipped").status).toBe(
      "skipped",
    );
  });

  test("an <error> element is `errored`", () => {
    const run = parsed(
      '<testsuites tests="1" failures="0" errors="1" skipped="0" time="0.1">' +
        '<testsuite name="x.test.ts" file="x.test.ts">' +
        '<testcase name="boom" classname="" time="0.02" file="x.test.ts"><error type="Error">boom</error></testcase>' +
        "</testsuite></testsuites>",
    );

    expect(caseNamed(run.cases, "boom").status).toBe("errored");
    expect(caseNamed(run.cases, "boom").durationMs).toBe(20);
    // `errors` is folded into failures: the wire has no third counter.
    expect(run.failures).toBe(1);
  });

  test("a failure message and stack are never carried on the case", () => {
    // The wire forbids content-derived text (#6); the parser does not even
    // hold it, so no later layer can forget to strip it.
    const run = parsed(
      '<testsuites tests="1" failures="1" skipped="0" time="0">' +
        '<testsuite name="x.test.ts" file="x.test.ts" hostname="box.local">' +
        '<testcase name="red" classname="" time="0" file="x.test.ts">' +
        '<failure message="expected 1 to be 2" type="AssertionError">at src/secret.ts:12</failure>' +
        "</testcase></testsuite></testsuites>",
    );
    const red = caseNamed(run.cases, "red");

    expect(Object.keys(red).sort()).toEqual([
      "chain",
      "durationMs",
      "file",
      "name",
      "status",
    ]);
    expect(JSON.stringify(run)).not.toContain("expected 1 to be 2");
    expect(JSON.stringify(run)).not.toContain("secret.ts");
    expect(JSON.stringify(run)).not.toContain("box.local");
  });
});

describe("attribute values are decoded exactly once", () => {
  test("entities in a test name decode to the literal characters", () => {
    const run = parsed(
      '<testsuites tests="1" failures="0" skipped="0" time="0">' +
        '<testsuite name="x.test.ts" file="x.test.ts">' +
        '<testcase name="a &lt; b &amp;&amp; c &gt; d &quot;q&quot; &#39;s&#39; &#x41;" classname="" time="0" file="x.test.ts" />' +
        "</testsuite></testsuites>",
    );

    expect(run.cases[0]?.name).toBe("a < b && c > d \"q\" 's' A");
  });

  test("a double-escaped classname is never consulted: the ancestry is", () => {
    // classname claims `b > a`; the ancestry says the one describe is `a`.
    const run = parsed(
      '<testsuites tests="1" failures="0" skipped="0" time="0">' +
        '<testsuite name="x.test.ts" file="x.test.ts">' +
        '<testsuite name="a" file="x.test.ts">' +
        '<testcase name="t" classname="b &amp;gt; a" time="0" file="x.test.ts" />' +
        "</testsuite></testsuite></testsuites>",
    );

    expect(run.cases[0]?.chain).toEqual(["a"]);
  });

  test("system-out CDATA and comments are skipped, not read as structure", () => {
    const run = parsed(
      '<testsuites tests="1" failures="0" skipped="0" time="0">' +
        '<!-- <testcase name="phantom"/> -->' +
        '<testsuite name="x.test.ts" file="x.test.ts">' +
        '<testcase name="ok" classname="" time="0" file="x.test.ts">' +
        '<system-out><![CDATA[<testcase name="ghost" classname="" time="0" file="x.test.ts"/>]]></system-out>' +
        "</testcase></testsuite></testsuites>",
    );

    expect(run.cases.map((entry) => entry.name)).toEqual(["ok"]);
  });
});

describe("a file the runner did not finish writing is refused, not half-read", () => {
  test("an unbalanced document is a parse failure with a reason", () => {
    const cut = MEASURED_XML.slice(0, MEASURED_XML.indexOf("dup name"));

    const result = parseJunit(cut);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  test("an empty file is a parse failure", () => {
    expect(parseJunit("").ok).toBe(false);
  });

  test("a document with no <testsuites> root is a parse failure", () => {
    expect(parseJunit("<html><body>not a report</body></html>").ok).toBe(false);
  });

  test("a root whose totals are not numbers is a parse failure", () => {
    expect(
      parseJunit(
        '<testsuites tests="many" failures="0" skipped="0" time="0"></testsuites>',
      ).ok,
    ).toBe(false);
  });
});
