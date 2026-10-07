/**
 * THE ENGLISH STEM, as the hub's database computes it (round 4): the stems
 * PostgreSQL's english_stem dictionary gives (PGlite 17, Snowball's English
 * algorithm), so the hub and a connector recounting an old hub match the same
 * words. Every expected value below is what the database printed; the server
 * suite pins the whole corpus vocabulary against the database itself
 * (server/test/english-stem-parity.test.ts).
 */
import { describe, expect, test } from "bun:test";

import { englishStem } from "../src/english-stem.ts";

describe("the stems the database computes", () => {
  test.each([
    // the inflections L1 is about: a closed-class word's forms share its stem
    ["shows", "show"], ["stopped", "stop"], ["runs", "run"], ["refreshed", "refresh"], ["refresh", "refresh"],
    // the corpus's own words
    ["timeouts", "timeout"], ["uploads", "upload"], ["rotation", "rotat"], ["rotated", "rotat"],
    ["invalidation", "invalid"], ["invalidated", "invalid"], ["persisted", "persist"], ["logged", "log"],
    ["organizations", "organ"], ["organization", "organ"], ["entries", "entri"], ["entry", "entri"],
    ["eviction", "evict"], ["evicts", "evict"], ["duplicates", "duplic"], ["duplicate", "duplic"],
    ["cache", "cach"], ["caches", "cach"], ["cached", "cach"], ["workers", "worker"], ["kontingent", "konting"],
    // step 1a
    ["caress", "caress"], ["bus", "bus"], ["gaps", "gap"], ["gas", "gas"], ["kiwis", "kiwi"], ["ties", "tie"], ["cried", "cri"],
    // step 1b
    ["agreed", "agre"], ["feed", "feed"], ["hopping", "hop"], ["hoping", "hope"], ["filing", "file"], ["fizzed", "fizz"],
    ["luxuriating", "luxuri"], ["consigned", "consign"], ["consigning", "consign"], ["falling", "fall"], ["billing", "bill"],
    // step 1c
    ["cry", "cri"], ["say", "say"], ["toy", "toy"], ["yay", "yay"], ["yesterday", "yesterday"],
    // steps 2 to 5
    ["traditional", "tradit"], ["sensational", "sensat"], ["conditional", "condit"], ["hopefully", "hope"], ["fulness", "ful"],
    ["fully", "fulli"], ["fullness", "full"], ["fluently", "fluentli"], ["electricity", "electr"], ["goodness", "good"],
    ["effective", "effect"], ["adjustment", "adjust"], ["dependent", "depend"], ["revival", "reviv"], ["allowance", "allow"],
    ["inference", "infer"], ["airliner", "airlin"], ["gyroscopic", "gyroscop"], ["adjustable", "adjust"], ["defensible", "defens"],
    ["irritant", "irrit"], ["replacement", "replac"], ["angularity", "angular"], ["homologous", "homolog"], ["effusive", "effus"],
    ["bowdlerize", "bowdler"], ["adoption", "adopt"], ["abatement", "abat"], ["sensibility", "sensibl"], ["antiquity", "antiqu"],
    ["consignment", "consign"], ["generate", "generat"], ["universal", "univers"], ["universities", "univers"], ["later", "later"],
    ["lateral", "later"], ["laterally", "later"], ["emergency", "emerg"], ["emerging", "emerg"], ["pasted", "past"], ["pastes", "past"],
    ["geologist", "geologist"], ["biologists", "biologist"], ["geologies", "geolog"], ["analogy", "analog"], ["apologies", "apolog"],
    ["catalog", "catalog"], ["stalled", "stall"], ["tell", "tell"], ["dwell", "dwell"], ["lexeme", "lexem"],
    // the R1 exceptions
    ["generous", "generous"], ["generously", "generous"], ["communal", "communal"], ["communism", "communism"],
    ["arsenal", "arsenal"], ["arsenic", "arsenic"],
    // the whole-word exceptions
    ["skies", "sky"], ["skis", "ski"], ["dying", "die"], ["lying", "lie"], ["news", "news"], ["atlas", "atlas"], ["bias", "bias"],
    ["andes", "andes"], ["cosmos", "cosmos"], ["howe", "howe"], ["sky", "sky"], ["idly", "idl"], ["singly", "singl"],
    ["ugly", "ugli"], ["early", "earli"], ["gently", "gentl"],
    ["proceeding", "proceed"], ["proceed", "proceed"], ["exceeds", "exceed"], ["succeeded", "succeed"],
    ["herring", "herring"], ["outing", "outing"], ["canning", "canning"], ["inning", "inning"], ["earring", "earring"],
    // what the dictionary leaves alone
    ["zurückgesetzt", "zurückgesetzt"], ["weiter", "weiter"], ["ähm", "ähm"],
  ])("%p stems to %p", (word, stem) => {
    expect(englishStem(word)).toBe(stem);
  });

  test("a word under three letters is its own stem", () => {
    expect(["ci", "id", "a"].map(englishStem)).toEqual(["ci", "id", "a"]);
  });
});
