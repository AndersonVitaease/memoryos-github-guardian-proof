# GitHub Guardian

An AI agent may need to merge a pull request. That does not mean it should receive unrestricted GitHub authority — or that yesterday's approval should remain valid after the PR changes.

GitHub Guardian is an experimental Guardian for **safe PR merge execution for AI agents**: every merge is bound to the observed repository state, revalidated immediately before the mutation, executed once through GitHub's native SHA precondition, and only called "done" when independent evidence proves it.

> Give AI agents capabilities. Not unrestricted authority.

## The problem

Merging a PR sounds like a single API call. For an autonomous agent it is a chain of decisions over a moving target:

- **Stale approval** — an approval captured against an earlier state can outlive the state it was based on.
- **PR HEAD changed** — new commits land after the decision or the approval; the old decision no longer describes reality.
- **Uncertain mergeability** — GitHub reports mergeability transiently; acting on insufficient evidence guesses.
- **Acceptance is not success** — the merge API accepting a request is not proof the merge happened.
- **Retries amplify uncertainty** — blindly retrying after an ambiguous failure can turn one uncertain state into additional mutations.

## What GitHub Guardian does

```
Intent
→ State snapshot
→ Approval bound to state (fingerprint)
→ Fresh revalidation
→ Controlled merge (native SHA precondition)
→ Independent verification
→ Evidence-based result
```

The flow is deliberately boring: observe, bind, re-check, act once, verify.

GitHub offers one important advantage in this domain: a **native SHA precondition**. The merge request carries `sha=<expectedHeadSha>`, derived from fresh evidence, so GitHub itself rejects the mutation if the PR head moved. This is a property of the GitHub API, not a general Guardian primitive — other domains do not always have an equivalent.

## Stale approval example

This exact case is covered by tests in this repository:

```
PR observed at HEAD A
→ approval bound to A (fingerprint)
→ PR changes to HEAD B
→ old execution attempted
→ SNAPSHOT_CHANGED
→ zero merge mutation
```

The approval does not silently stretch to cover the new state. The merge is refused before any mutation occurs.

## Success is evidence, not acceptance

```
merge API accepted  ≠  merge proven successful
```

After the single merge attempt, GitHub Guardian performs an **independent GET** against the PR and only reports `VERIFIED` when the response confirms `merged`. Backend acceptance is never treated as success on its own. When mergeability evidence is transient or insufficient, the outcome is `UNKNOWN` — not a guess.

## What was tested

Baseline certified on this repository:

- **51/51 PASS** (Vitest) + `TYPECHECK=PASS`
- real PR merge proof (merge, then independent post-merge GET)
- stale approval proof (`SNAPSHOT_CHANGED`, zero merge mutation)
- native SHA precondition (`sha=expectedHeadSha` from fresh evidence)
- exactly one merge attempt; zero unsafe retry
- backend acceptance not treated as success; independent GET confirms before `VERIFIED`
- transient/indeterminate mergeability handled as `UNKNOWN`

Reproduce locally:

```bash
npm install
npm run typecheck
npm test
```

Repository layout:

```
src/       plan / prepare / execute PR merge + GitHub adapters
test/      Vitest baseline (51 tests) incl. stale-state and redaction tests
scripts/   live proof drivers (plan, revalidation, merge)
```

## Architecture / relationship to Guardian Core

This repository is an **independent, domain-specific proof**: it does not import Guardian Core at runtime.

```
GitHub Guardian (this repo — GitHub PR merge domain)
↓
Guardian Core concepts / conformance
↓
GitHub API
```

[Guardian Core](https://github.com/AndersonVitaease/memoryos-guardian-core) is the experimental domain-agnostic Safe Execution Core behind the broader Guardian model. The concepts proven here — state snapshot, approval bound to state, fail-closed refusal, evidence-based outcomes — were later formalized and conformance-tested in Guardian Core (v0.1.0).

## Limitations

- Experimental. This is **not** production certification.
- Evidence applies to the tested GitHub PR merge path only.
- No malicious-adapter guarantee.
- No universal exactly-once guarantee.
- GitHub API/backend semantics remain external dependencies.
- `UNKNOWN`/indeterminate outcomes remain possible — by design, they are never guessed away.
- The native SHA precondition strengthens this domain but is not a universal Guardian primitive.
- No LICENSE file is included yet; all rights reserved by the author. Public visibility does not make this open source.

## Guardian ecosystem

- [Guardian Core](https://github.com/AndersonVitaease/memoryos-guardian-core) — experimental domain-agnostic Safe Execution Core (bind → gate → apply, fail-closed).
- [VPS Guardian](https://github.com/AndersonVitaease/memoryos-vps-guardian-pro) — governed VPS/Dokploy application redeploy with supervised rollback evidence.
- [Filesystem Guardian](https://github.com/AndersonVitaease/memoryos-filesystem-guardian-proof) — stale-state-safe file changes with bounded filesystem authority and read-back verification.
- [Email Guardian](https://github.com/AndersonVitaease/memoryos-email-guardian-proof) — bounded outbound email execution with stale-state protection, same-instance keyed duplicate suppression and evidence-based outcomes.
