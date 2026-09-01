#!/bin/sh
#
# EXAMPLE crosscheck foreign-model wrapper — the operator lane of
# docs/FOREIGN-MODELS.md, in about twenty lines.
#
# Point CROSSCHECK_SUMMARIZER_CMD at this file (an absolute path, or a name on
# the PATH — nothing else resolves; see the doc) and crosscheck's Tier-1
# summarizer runs on your model instead of the default `claude -p`.
#
#   export CX_MODEL_URL=https://your-provider.example/v1/chat/completions
#   export CX_MODEL_KEY=...
#   export CX_MODEL_NAME=the-model-id-your-provider-expects
#   export CROSSCHECK_SUMMARIZER_CMD=$HOME/.local/bin/crosscheck-model
#
# THE CONTRACT THIS FILE IMPLEMENTS, and the whole of it: crosscheck spawns
# this with NO arguments, writes one turn's slice to stdin, reads one answer
# from stdout, and expects exit 0. Anything else — how you reach a model,
# which model, what you pay — is yours.
#
# NO PROVIDER IS NAMED HERE ON PURPOSE. The request and response shapes below
# are the OpenAI-compatible chat-completions shape that many providers expose;
# whether YOUR provider does, and whether its model answers well, is something
# only you can check (`crosscheck doctor` runs it once and prints what it
# said). Nothing in this repository has been run against any vendor's model.
#
# WHAT THIS EXAMPLE DOES NOT DO: tell the four tasks apart. crosscheck uses one
# variable for the summarizer, the session intent, the ghost check and
# `crosscheck conference`, and hands the wrapper no argument saying which
# fired — so the instruction below is the SUMMARIZER's, and the other three
# would get it too. docs/FOREIGN-MODELS.md §"What is not guaranteed" says what
# that costs and what to do about it.
#
# jq is required — for BOTH directions. A slice contains quotes, newlines and
# backslashes, and hand-rolling JSON escaping in shell is how a wrapper starts
# corrupting the very turns it is meant to read.
set -eu

: "${CX_MODEL_URL:?set CX_MODEL_URL to your provider's OpenAI-compatible chat-completions URL}"
: "${CX_MODEL_KEY:?set CX_MODEL_KEY to your provider's API key}"
: "${CX_MODEL_NAME:?set CX_MODEL_NAME to the model id your provider expects}"

# The summarizer's instruction, verbatim from SUMMARIZER_PROMPT in
# packages/connector-core/src/model/runner.ts. Keep it in step with that
# constant: the default backend passes it on argv, and an override gets none.
INSTRUCTION='You are a passive capture assistant for a team knowledge tool. Below is a slice of one coding-session turn. If it contains ONE concrete conclusion a teammate working in the same area would act on — a diagnostic finding about a bug or failure, a decision reached and its reason, an approach ruled out and why, or what a review found — answer with ONLY a JSON object of the form {"kind": "<observation|hypothesis|evidence|root_cause|decision|rejected_approach>", "body": "<the conclusion as one sentence, max 400 characters>", "confidence": <a number between 0 and 0.5>} and nothing else. The body must state the conclusion itself — what was decided, found or ruled out, and why — and never narrate the session. Progress reports ("tests pass now", "implemented X"), plans, and praise are not conclusions. If there is no such conclusion, answer with exactly NONE.'

SLICE=$(cat)

BODY=$(INSTRUCTION="$INSTRUCTION" SLICE="$SLICE" MODEL="$CX_MODEL_NAME" jq -n '{
  model: env.MODEL,
  messages: [
    { role: "system", content: env.INSTRUCTION },
    { role: "user",   content: env.SLICE }
  ]
}')

# --max-time sits UNDER crosscheck's own 60 s deadline, so a slow provider
# comes back as this wrapper failing rather than as crosscheck killing it: the
# booked reason is more useful when the wrapper is the one that gave up.
# `NONE` as the jq fallback is deliberate — a response this expression cannot
# read is a turn with no conclusion, which is the cheap direction.
curl --silent --show-error --fail --max-time 55 \
  --header "Authorization: Bearer ${CX_MODEL_KEY}" \
  --header "Content-Type: application/json" \
  --data "$BODY" \
  "$CX_MODEL_URL" \
| jq --raw-output '.choices[0].message.content // "NONE"'
