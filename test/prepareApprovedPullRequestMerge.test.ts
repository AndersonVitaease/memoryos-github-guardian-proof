/**
 * GH-00 — Deterministic tests for approval + fresh revalidation + snapshot
 * fingerprint comparison. All HTTP-free: fake read-only adapter only.
 */
import { describe, expect, it } from "vitest";

import type {
  PullRequestAdapter,
  PullRequestEvidence,
  PullRequestQuery,
} from "../src/githubAdapter";
import {
  computeProposalFingerprint,
  planPullRequestMerge,
} from "../src/planPullRequestMerge";
import {
  prepareApprovedPullRequestMerge,
  type PreparedMergeOutcome,
} from "../src/prepareApprovedPullRequestMerge";

const REPO = "AndersonVitaease/memoryos-github-guardian-proof";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SECRET_LIKE = "ghp_" + "Zx9".repeat(13); // must NEVER appear in any output

function evidence(overrides: Partial<PullRequestEvidence> = {}): PullRequestEvidence {
  return {
    repository: REPO,
    pullRequestNumber: 1,
    state: "OPEN",
    baseBranch: "main",
    headBranch: "gh00/live-proof",
    headSha: SHA_A,
    mergeableState: "MERGEABLE",
    checks: [],
    ...overrides,
  };
}

/** Read-only fake adapter (implements the certified interface; no other methods). */
class FakeAdapter implements PullRequestAdapter {
  readonly calls: Array<{ method: string; query: PullRequestQuery }> = [];
  /** Simulates a credential owned INSIDE a real adapter. Never returned anywhere. */
  readonly internalCredential = SECRET_LIKE;
  constructor(private readonly current: PullRequestEvidence | null) {}
  async getPullRequestEvidence(query: PullRequestQuery): Promise<PullRequestEvidence | null> {
    this.calls.push({ method: "getPullRequestEvidence", query: { ...query } });
    return this.current;
  }
}

const BASE_INPUT = {
  repository: REPO,
  pullRequestNumber: 1,
  execute: true,
  approval: { approved: true },
} as const;

async function fingerprintFor(current: PullRequestEvidence | null): Promise<string> {
  const plan = await planPullRequestMerge(
    { repository: REPO, pullRequestNumber: 1 },
    { adapter: new FakeAdapter(current) },
  );
  if (plan.status !== "PLAN_READY" || plan.proposalFingerprint === undefined) {
    throw new Error(`fixture not PLAN_READY: ${plan.status}`);
  }
  return plan.proposalFingerprint;
}

describe("GH-00 approval + revalidation + snapshot invalidation", () => {
  it("1. execute=false -> APPROVAL_REQUIRED, zero mutation, no evidence fetch", async () => {
    const adapter = new FakeAdapter(evidence());
    const outcome = await prepareApprovedPullRequestMerge(
      { ...BASE_INPUT, execute: false, approval: { approved: true, proposalFingerprint: "e".repeat(64) } },
      { adapter },
    );
    expect(outcome.status).toBe("APPROVAL_REQUIRED");
    expect(outcome.mutationPerformed).toBe(false);
    expect(outcome.evidence).toBeNull();
    expect(outcome.reasons).toEqual(["EXECUTE_REQUIRED"]);
    expect("currentFingerprint" in outcome).toBe(false);
    expect(adapter.calls.length).toBe(0);
  });

  it("2. approval.approved=false -> APPROVAL_REQUIRED, zero mutation, no evidence fetch", async () => {
    const adapter = new FakeAdapter(evidence());
    const outcome = await prepareApprovedPullRequestMerge(
      { ...BASE_INPUT, approval: { approved: false, proposalFingerprint: "e".repeat(64) } },
      { adapter },
    );
    expect(outcome.status).toBe("APPROVAL_REQUIRED");
    expect(outcome.mutationPerformed).toBe(false);
    expect(outcome.evidence).toBeNull();
    expect(outcome.reasons).toEqual(["APPROVAL_NOT_GRANTED"]);
    expect(adapter.calls.length).toBe(0);
  });

  it("3. fingerprint absent -> BLOCKED (fail-closed), no evidence fetch", async () => {
    const adapter = new FakeAdapter(evidence());
    const outcome = await prepareApprovedPullRequestMerge(
      { ...BASE_INPUT, approval: { approved: true } },
      { adapter },
    );
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.mutationPerformed).toBe(false);
    expect(outcome.reasons).toEqual(["PROPOSAL_FINGERPRINT_MALFORMED"]);
    expect(adapter.calls.length).toBe(0);
  });

  it("4. malformed fingerprints (uppercase/short/long/non-hex/non-string) -> BLOCKED", async () => {
    const malformed: unknown[] = [
      "",
      "A".repeat(64), // uppercase
      "a".repeat(63), // short
      "a".repeat(65), // long
      "z".repeat(64), // non-hex
      "e".repeat(63) + "g", // trailing non-hex
      123, // not a string
      null,
    ];
    for (const proposalFingerprint of malformed) {
      const adapter = new FakeAdapter(evidence());
      const outcome = await prepareApprovedPullRequestMerge(
        { ...BASE_INPUT, approval: { approved: true, proposalFingerprint } },
        { adapter },
      );
      expect(outcome.status).toBe("BLOCKED");
      expect(outcome.mutationPerformed).toBe(false);
      expect(outcome.reasons).toEqual(["PROPOSAL_FINGERPRINT_MALFORMED"]);
      expect(adapter.calls.length).toBe(0);
    }
  });

  it("5. valid but different fingerprint -> SNAPSHOT_CHANGED with both fingerprints", async () => {
    const current = evidence(); // headSha SHA_A
    const stale = await fingerprintFor(evidence({ headSha: SHA_B }));
    const adapter = new FakeAdapter(current);
    const outcome = await prepareApprovedPullRequestMerge(
      { ...BASE_INPUT, approval: { approved: true, proposalFingerprint: stale } },
      { adapter },
    );
    expect(outcome.status).toBe("SNAPSHOT_CHANGED");
    expect(outcome.mutationPerformed).toBe(false);
    expect(outcome.approvedFingerprint).toBe(stale);
    expect(outcome.currentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.currentFingerprint).not.toBe(outcome.approvedFingerprint);
    expect(outcome.evidence?.headSha).toBe(SHA_A);
    expect(outcome.reasons).toEqual(["SNAPSHOT_FINGERPRINT_MISMATCH"]);
    expect(adapter.calls.length).toBe(1);
  });

  it("6. head SHA changed between approval and revalidation -> SNAPSHOT_CHANGED", async () => {
    const approved = await fingerprintFor(evidence({ headSha: SHA_A }));
    const adapter = new FakeAdapter(evidence({ headSha: SHA_B })); // state moved on
    const outcome = await prepareApprovedPullRequestMerge(BASE_INPUT_LOADER(approved), { adapter });
    expect(outcome.status).toBe("SNAPSHOT_CHANGED");
    expect(outcome.mutationPerformed).toBe(false);
    expect(outcome.evidence?.headSha).toBe(SHA_B);
    expect(outcome.currentFingerprint).not.toBe(approved);
  });

  it("7. base branch changed to non-allowed -> BLOCKED by prechecks, zero mutation", async () => {
    const approved = await fingerprintFor(evidence());
    const adapter = new FakeAdapter(evidence({ baseBranch: "develop" }));
    const outcome = await prepareApprovedPullRequestMerge(BASE_INPUT_LOADER(approved), { adapter });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.mutationPerformed).toBe(false);
    expect(outcome.reasons).toContain("BASE_BRANCH_NOT_ALLOWED");
    expect(outcome.currentFingerprint).toBeNull();
  });

  it("8. OPEN became CLOSED -> BLOCKED, zero mutation", async () => {
    const approved = await fingerprintFor(evidence());
    const adapter = new FakeAdapter(evidence({ state: "CLOSED" }));
    const outcome = await prepareApprovedPullRequestMerge(BASE_INPUT_LOADER(approved), { adapter });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.mutationPerformed).toBe(false);
    expect(outcome.reasons).toContain("PULL_REQUEST_NOT_OPEN");
  });

  it("9. checks became FAILED -> BLOCKED, zero mutation", async () => {
    const approved = await fingerprintFor(evidence());
    const adapter = new FakeAdapter(
      evidence({ checks: [{ name: "ci", conclusion: "FAILED" }] }),
    );
    const outcome = await prepareApprovedPullRequestMerge(BASE_INPUT_LOADER(approved), { adapter });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.mutationPerformed).toBe(false);
    expect(outcome.reasons).toContain("CHECKS_FAILED");
  });

  it("10. identical snapshot + correct approval -> APPROVED_SNAPSHOT_VALID", async () => {
    const current = evidence();
    const approved = await fingerprintFor(evidence());
    const adapter = new FakeAdapter(current);
    const outcome = await prepareApprovedPullRequestMerge(BASE_INPUT_LOADER(approved), { adapter });
    expect(outcome.status).toBe("APPROVED_SNAPSHOT_VALID");
    expect(outcome.mutationPerformed).toBe(false);
    expect(outcome.approvedFingerprint).toBe(approved);
    expect(outcome.currentFingerprint).toBe(approved);
    expect(outcome.evidence?.headSha).toBe(SHA_A);
    expect(outcome.evidence?.checksState).toBe("NO_KNOWN_CHECKS");
    expect(outcome.reasons).toEqual([]);
    expect(adapter.calls.length).toBe(1); // fresh evidence was fetched
  });

  it("11. no route can mutate: read-only surface only, single evidence fetch", async () => {
    const domain = await import("../src/planPullRequestMerge");
    const runtimeExports = Object.keys(domain);
    // No mutation surface anywhere in the domain or this stage.
    for (const name of runtimeExports) {
      expect(name).not.toMatch(/^(execute|merge[A-Z]|applyMerge|doMerge|performMerge)/);
    }
    const approved = await fingerprintFor(evidence());
    const adapter = new FakeAdapter(evidence());
    const outcome = await prepareApprovedPullRequestMerge(BASE_INPUT_LOADER(approved), { adapter });
    expect(outcome.mutationPerformed).toBe(false);
    expect(adapter.calls.map((call) => call.method)).toEqual(["getPullRequestEvidence"]);
    expect(adapter.calls[0]?.query).toEqual({ repository: REPO, pullRequestNumber: 1 });
  });

  it("12. tokens/credentials never appear in outputs; mutationPerformed always false", async () => {
    const adapterWithSecret = new FakeAdapter(evidence());
    const approved = await fingerprintFor(evidence());
    const outcomes: PreparedMergeOutcome[] = [];
    outcomes.push(
      await prepareApprovedPullRequestMerge(
        { ...BASE_INPUT, execute: false },
        { adapter: adapterWithSecret },
      ),
      await prepareApprovedPullRequestMerge(
        { ...BASE_INPUT, approval: { approved: false } },
        { adapter: adapterWithSecret },
      ),
      await prepareApprovedPullRequestMerge(
        BASE_INPUT_LOADER(approved),
        { adapter: adapterWithSecret },
      ),
      await prepareApprovedPullRequestMerge(
        { ...BASE_INPUT, approval: { approved: true, proposalFingerprint: "0".repeat(64) } },
        { adapter: adapterWithSecret },
      ),
    );
    for (const outcome of outcomes) {
      expect(outcome.mutationPerformed).toBe(false);
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toMatch(/ghp_|gho_|ghu_|ghs_|ghr_|github_pat_/i);
      expect(serialized).not.toMatch(/authorization|bearer|secret|password/i);
    }
    // The adapter's internal credential never leaks through the domain:
    // outcomes carry evidence and fingerprints only, never credentials.
    expect(JSON.stringify(outcomes)).not.toContain(SECRET_LIKE);
    // The four gate/revalidation paths above made exactly two evidence fetches
    // (the two approval gates fetch nothing; the two valid fingerprints revalidate).
    expect(adapterWithSecret.calls.length).toBe(2);
  });
});

/** Small helper to keep test inputs compact and explicit. */
function BASE_INPUT_LOADER(proposalFingerprint: string) {
  return {
    repository: REPO,
    pullRequestNumber: 1,
    execute: true,
    approval: { approved: true, proposalFingerprint },
  } as const;
}
