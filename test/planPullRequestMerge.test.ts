import { describe, expect, it } from "vitest";

import type { PullRequestAdapter, PullRequestEvidence } from "../src/githubAdapter";
import { planPullRequestMerge } from "../src/planPullRequestMerge";

const ALLOWED_REPO = "AndersonVitaease/memoryos-github-guardian-proof";
const OTHER_REPO = "AndersonVitaease/some-other-repo";
const HEAD_SHA_A = "abcdef0123".repeat(4); // 40 lowercase hex chars
const HEAD_SHA_B = "1234567890".repeat(4); // different valid head SHA

/** READ-ONLY fake adapter for tests: returns fixed evidence, performs no writes. */
function fakeAdapter(evidence: PullRequestEvidence | null): PullRequestAdapter {
  return {
    async getPullRequestEvidence() {
      return evidence;
    },
  };
}

function validEvidence(overrides: Partial<PullRequestEvidence> = {}): PullRequestEvidence {
  return {
    repository: ALLOWED_REPO,
    pullRequestNumber: 7,
    state: "OPEN",
    baseBranch: "main",
    headBranch: "feature/pr-7",
    headSha: HEAD_SHA_A,
    mergeableState: "MERGEABLE",
    checks: [{ name: "ci", conclusion: "SUCCESS" }],
    ...overrides,
  };
}

function deps(evidence: PullRequestEvidence | null, config?: Parameters<typeof planPullRequestMerge>[1]["config"]) {
  return { adapter: fakeAdapter(evidence), ...(config ? { config } : {}) };
}

const SECRET_PATTERN = /gh[pousr]_[A-Za-z0-9]|github_pat|token|credential|secret|password|authorization|bearer/i;

const ALL_SCENARIOS: ReadonlyArray<ReadonlyArray<Partial<PullRequestEvidence>>> = [
  [],
  [{ repository: OTHER_REPO }],
  [{ baseBranch: "develop" }],
  [{ state: "CLOSED" }],
  [{ mergeableState: "NOT_MERGEABLE" }],
  [{ checks: [{ name: "ci", conclusion: "FAILED" }] }],
  [{ state: null }],
  [{ mergeableState: "UNKNOWN" }],
  [{ headSha: null }],
  [{ checks: null }],
];

describe("GH-00 planPullRequestMerge (READ-ONLY)", () => {
  it("1. valid state -> PLAN_READY, mutationPerformed=false, 64-hex fingerprint", async () => {
    const outcome = await planPullRequestMerge(
      { repository: ALLOWED_REPO, pullRequestNumber: 7 },
      deps(validEvidence()),
    );
    expect(outcome.status).toBe("PLAN_READY");
    expect(outcome.mutationPerformed).toBe(false);
    expect(outcome.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.reasons).toEqual([]);
    expect(outcome.evidence.checksState).toBe("NOT_FAILED");
    expect(outcome.evidence.headSha).toBe(HEAD_SHA_A);
  });

  it("2. same snapshot twice -> same fingerprint", async () => {
    const input = { repository: ALLOWED_REPO, pullRequestNumber: 7 };
    const first = await planPullRequestMerge(input, deps(validEvidence()));
    const second = await planPullRequestMerge(input, deps(validEvidence()));
    expect(first.proposalFingerprint).toBe(second.proposalFingerprint);
expect(second.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("3. different headSha -> different fingerprint", async () => {
    const first = await planPullRequestMerge(
      { repository: ALLOWED_REPO, pullRequestNumber: 7 },
      deps(validEvidence()),
    );
    const second = await planPullRequestMerge(
      { repository: ALLOWED_REPO, pullRequestNumber: 7 },
      deps(validEvidence({ headSha: HEAD_SHA_B })),
    );
    expect(first.status).toBe("PLAN_READY");
    expect(second.status).toBe("PLAN_READY");
    expect(first.proposalFingerprint).not.toBe(second.proposalFingerprint);
  });

  it("4. repository not allowed -> BLOCKED, no fingerprint", async () => {
    const outcome = await planPullRequestMerge(
      { repository: OTHER_REPO, pullRequestNumber: 7 },
      deps(validEvidence({ repository: OTHER_REPO })),
    );
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reasons).toEqual(["REPOSITORY_NOT_ALLOWED"]);
    expect(outcome.proposalFingerprint).toBeUndefined();
    expect(outcome.mutationPerformed).toBe(false);
  });

  it("5. base branch not allowed -> BLOCKED", async () => {
    const outcome = await planPullRequestMerge(
      { repository: ALLOWED_REPO, pullRequestNumber: 7 },
      deps(validEvidence({ baseBranch: "develop" })),
    );
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reasons).toEqual(["BASE_BRANCH_NOT_ALLOWED"]);
    expect(outcome.proposalFingerprint).toBeUndefined();
  });

  it("6. CLOSED PR -> BLOCKED", async () => {
    const outcome = await planPullRequestMerge(
      { repository: ALLOWED_REPO, pullRequestNumber: 7 },
      deps(validEvidence({ state: "CLOSED" })),
    );
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reasons).toEqual(["PULL_REQUEST_NOT_OPEN"]);
  });

  it("7. known non-mergeable -> BLOCKED", async () => {
    const outcome = await planPullRequestMerge(
      { repository: ALLOWED_REPO, pullRequestNumber: 7 },
      deps(validEvidence({ mergeableState: "NOT_MERGEABLE" })),
    );
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reasons).toEqual(["NOT_MERGEABLE"]);
  });

  it("8. known check FAILED -> BLOCKED", async () => {
    const outcome = await planPullRequestMerge(
      { repository: ALLOWED_REPO, pullRequestNumber: 7 },
      deps(validEvidence({ checks: [{ name: "ci", conclusion: "FAILED" }] })),
    );
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reasons).toEqual(["CHECKS_FAILED"]);
    expect(outcome.evidence.checksState).toBe("FAILED");
  });

  it("9. missing/indeterminate evidence -> UNKNOWN (fail-closed, never PASS)", async () => {
    const cases: ReadonlyArray<{ overrides: Partial<PullRequestEvidence>; reason: string }> = [
      { overrides: { state: null }, reason: "PULL_REQUEST_STATE_INDETERMINATE" },
      { overrides: { mergeableState: "UNKNOWN" }, reason: "MERGEABLE_STATE_INDETERMINATE" },
      { overrides: { headSha: null }, reason: "HEAD_SHA_MISSING" },
      { overrides: { checks: null }, reason: "CHECKS_INDETERMINATE" },
    ];
    for (const testCase of cases) {
      const outcome = await planPullRequestMerge(
        { repository: ALLOWED_REPO, pullRequestNumber: 7 },
        deps(validEvidence(testCase.overrides)),
      );
      expect(outcome.status, testCase.reason).toBe("UNKNOWN");
      expect(outcome.reasons).toEqual([testCase.reason]);
      expect(outcome.proposalFingerprint).toBeUndefined();
      expect(outcome.mutationPerformed).toBe(false);
    }
  });

  it("9b. PR not found (null evidence) -> BLOCKED", async () => {
    const outcome = await planPullRequestMerge(
      { repository: ALLOWED_REPO, pullRequestNumber: 404 },
      deps(null),
    );
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reasons).toEqual(["PULL_REQUEST_NOT_FOUND"]);
  });

  it("10. no path performs a mutation", async () => {
    const outcomes = [];
    for (const overrides of ALL_SCENARIOS) {
      const evidence =
        overrides.length > 0 && overrides[0].repository === OTHER_REPO
          ? validEvidence(...overrides)
          : validEvidence(...overrides);
      const outcome = await planPullRequestMerge(
        { repository: evidence?.repository ?? ALLOWED_REPO, pullRequestNumber: 7 },
        deps(evidence),
      );
      outcomes.push(outcome);
    }
    outcomes.push(
      await planPullRequestMerge({ repository: ALLOWED_REPO, pullRequestNumber: 404 }, deps(null)),
    );
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      expect(outcome.mutationPerformed).toBe(false);
    }
  });

  it("11. outputs never contain token/credential/secret", async () => {
    for (const overrides of ALL_SCENARIOS) {
      const evidence =
        overrides.length > 0 && overrides[0].repository === OTHER_REPO
          ? validEvidence(...overrides)
          : validEvidence(...overrides);
      const outcome = await planPullRequestMerge(
        { repository: evidence.repository, pullRequestNumber: 7 },
        deps(evidence),
      );
      const serialized = JSON.stringify(outcome);
      expect(serialized).toBeTruthy();
      expect(serialized).not.toMatch(SECRET_PATTERN);
    }
  });
});
