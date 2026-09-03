/**
 * GH-00 — Deterministic tests for the controlled merge + SHA precondition +
 * independent post-validation. All HTTP-free: fake adapters only.
 */
import { describe, expect, it } from "vitest";

import type {
  PullRequestAdapter,
  PullRequestEvidence,
  PullRequestQuery,
} from "../src/githubAdapter";
import type {
  GithubFetch,
  MergeBackendOutcome,
} from "../src/githubPullRequestMergeAdapter";
import { GitHubPullRequestMergeAdapter } from "../src/githubPullRequestMergeAdapter";
import { planPullRequestMerge } from "../src/planPullRequestMerge";
import {
  executeApprovedPullRequestMerge,
  type ExecutedMergeOutcome,
} from "../src/executeApprovedPullRequestMerge";

const REPO = "AndersonVitaease/memoryos-github-guardian-proof";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

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

/** Records every merge attempt. Zero retry is observable through its length. */
class RecordingMergeAdapter {
  readonly calls: Array<{ repository: string; pullRequestNumber: number; expectedHeadSha: string }> = [];
  constructor(private readonly result: MergeBackendOutcome) {}
  async mergePullRequest(request: { repository: string; pullRequestNumber: number; expectedHeadSha: string }): Promise<MergeBackendOutcome> {
    this.calls.push({ ...request });
    return { ...this.result };
  }
}

/** Read-only evidence adapter whose responses are scripted per call index. */
class ScriptedReadAdapter implements PullRequestAdapter {
  readonly calls: PullRequestQuery[] = [];
  constructor(private readonly script: Array<PullRequestEvidence | null>) {}
  async getPullRequestEvidence(query: PullRequestQuery): Promise<PullRequestEvidence | null> {
    this.calls.push({ ...query });
    const next = this.script.shift();
    return next ?? null;
  }
}

const BASE = {
  repository: REPO,
  pullRequestNumber: 1,
  execute: true,
  approval: { approved: true },
} as const;

async function fingerprintFor(current: PullRequestEvidence | null): Promise<string> {
  const plan = await planPullRequestMerge(
    { repository: REPO, pullRequestNumber: 1 },
    { adapter: { async getPullRequestEvidence() { return current; } } },
  );
  if (plan.status !== "PLAN_READY" || plan.proposalFingerprint === undefined) {
    throw new Error(`fixture not PLAN_READY: ${plan.status}`);
  }
  return plan.proposalFingerprint;
}

const ACCEPTED = { result: "ACCEPTED" as const, reason: "MERGE_BACKEND_ACCEPTED", backendStatus: 200 };
const SHA_MISMATCH = { result: "REJECTED" as const, reason: "MERGE_REJECTED_PRECONDITION_SHA_OR_STATE", backendStatus: 409 };
const NETWORK_AMBIGUOUS = { result: "AMBIGUOUS" as const, reason: "MERGE_BACKEND_AMBIGUOUS_NETWORK", backendStatus: null };

describe("GH-00 controlled merge: gates allow zero mutation", () => {
  const validFp = "e".repeat(64);

  it("1. execute=false -> no merge attempt at all", async () => {
    const merge = new RecordingMergeAdapter(ACCEPTED);
    const outcome = await executeApprovedPullRequestMerge(
      { ...BASE, execute: false, approval: { approved: true, proposalFingerprint: validFp } },
      { adapter: { async getPullRequestEvidence() { return evidence(); } }, mergeAdapter: merge },
    );
    expect(outcome.status).toBe("APPROVAL_REQUIRED");
    expect(outcome.mutationPerformed).toBe(false);
    expect(outcome.mergeAttempted).toBe(false);
    expect(merge.calls.length).toBe(0);
  });

  it("2. approval.approved=false -> no merge attempt at all", async () => {
    const merge = new RecordingMergeAdapter(ACCEPTED);
    const outcome = await executeApprovedPullRequestMerge(
      { ...BASE, approval: { approved: false, proposalFingerprint: "e".repeat(64) } },
      { adapter: { async getPullRequestEvidence() { return evidence(); } }, mergeAdapter: merge },
    );
    expect(outcome.status).toBe("APPROVAL_REQUIRED");
    expect(outcome.mutationPerformed).toBe(false);
    expect(merge.calls.length).toBe(0);
  });

  it("3. invalid fingerprint -> BLOCKED, no merge attempt", async () => {
    for (const proposalFingerprint of [undefined, "XYZ", "A".repeat(64), "e".repeat(63)]) {
      const merge = new RecordingMergeAdapter(ACCEPTED);
      const outcome = await executeApprovedPullRequestMerge(
        { ...BASE, approval: { approved: true, proposalFingerprint } },
        { adapter: { async getPullRequestEvidence() { return evidence(); } }, mergeAdapter: merge },
      );
      expect(outcome.status).toBe("BLOCKED");
      expect(merge.calls.length).toBe(0);
      expect(outcome.mutationPerformed).toBe(false);
    }
  });

  it("4. snapshot changed -> SNAPSHOT_CHANGED, no merge attempt", async () => {
    const approved = await fingerprintFor(evidence({ headSha: SHA_B }));
    const merge = new RecordingMergeAdapter(ACCEPTED);
    const outcome = await executeApprovedPullRequestMerge(
      { ...BASE, approval: { approved: true, proposalFingerprint: approved } },
      { adapter: { async getPullRequestEvidence() { return evidence({ headSha: SHA_A }); } }, mergeAdapter: merge },
    );
    expect(outcome.status).toBe("SNAPSHOT_CHANGED");
    expect(outcome.mergeAttempted).toBe(false);
    expect(outcome.mutationPerformed).toBe(false);
    expect(merge.calls.length).toBe(0);
  });

  it("5. fresh PLAN BLOCKED or UNKNOWN -> propagated fail-closed, no merge attempt", async () => {
    const approved = await fingerprintFor(evidence());
    const merge = new RecordingMergeAdapter(ACCEPTED);
    const blockedOutcome = await executeApprovedPullRequestMerge(
      { ...BASE, approval: { approved: true, proposalFingerprint: approved } },
      { adapter: { async getPullRequestEvidence() { return evidence({ state: "CLOSED" }); } }, mergeAdapter: merge },
    );
    expect(blockedOutcome.status).toBe("BLOCKED");
    expect(blockedOutcome.reasons).toContain("PULL_REQUEST_NOT_OPEN");
    expect(merge.calls.length).toBe(0);

    const merge2 = new RecordingMergeAdapter(ACCEPTED);
    const unknownOutcome = await executeApprovedPullRequestMerge(
      { ...BASE, approval: { approved: true, proposalFingerprint: approved } },
      { adapter: { async getPullRequestEvidence() { return evidence({ mergeableState: "UNKNOWN" }); } }, mergeAdapter: merge2 },
    );
    expect(unknownOutcome.status).toBe("UNKNOWN");
    expect(unknownOutcome.currentFingerprint).toBeNull();
    expect(merge2.calls.length).toBe(0);
  });
});

describe("GH-00 controlled merge: governed execution", () => {
  it("6+7. APPROVED_SNAPSHOT_VALID -> merge adapter called EXACTLY ONCE with the fresh evidence headSha", async () => {
    const approved = await fingerprintFor(evidence({ headSha: SHA_A }));
    const merge = new RecordingMergeAdapter(ACCEPTED);
    const read = new ScriptedReadAdapter([
      evidence({ headSha: SHA_A }), // revalidation read
      evidence({ state: "MERGED", headSha: SHA_B }), // post-validation read
    ]);
    const outcome = await executeApprovedPullRequestMerge(
      { ...BASE, approval: { approved: true, proposalFingerprint: approved } },
      { adapter: read, mergeAdapter: merge },
    );
    expect(outcome.status).toBe("VERIFIED");
    expect(merge.calls.length).toBe(1); // exactly once
    expect(merge.calls[0]).toEqual({
      repository: REPO,
      pullRequestNumber: 1,
      expectedHeadSha: SHA_A, // ONLY the fresh validated evidence SHA
    });
  });

  it("8. caller cannot supply an alternative SHA: no input field can influence it", async () => {
    const approved = await fingerprintFor(evidence({ headSha: SHA_A }));
    const merge = new RecordingMergeAdapter(ACCEPTED);
    const read = new ScriptedReadAdapter([
      evidence({ headSha: SHA_A }),
      evidence({ state: "MERGED" }),
    ]);
    const hostile = { ...BASE, approval: { approved: true, proposalFingerprint: approved } } as Record<string, unknown>;
    hostile.expectedHeadSha = SHA_B; // any caller-side SHA is structurally ignored
    (hostile.approval as Record<string, unknown>).expectedHeadSha = SHA_B;
    const outcome = await executeApprovedPullRequestMerge(
      hostile as unknown as Parameters<typeof executeApprovedPullRequestMerge>[0],
      { adapter: read, mergeAdapter: merge },
    );
    expect(outcome.status).toBe("VERIFIED");
    expect(merge.calls[0]?.expectedHeadSha).toBe(SHA_A); // fresh evidence only
  });

  it("11. backend SHA-mismatch rejection -> FAILED, zero retry (one call)", async () => {
    const approved = await fingerprintFor(evidence({ headSha: SHA_A }));
    const merge = new RecordingMergeAdapter(SHA_MISMATCH);
    const outcome = await executeApprovedPullRequestMerge(
      { ...BASE, approval: { approved: true, proposalFingerprint: approved } },
      { adapter: { async getPullRequestEvidence() { return evidence({ headSha: SHA_A }); } }, mergeAdapter: merge },
    );
    expect(outcome.status).toBe("FAILED");
    expect(outcome.mutationPerformed).toBe(true); // the attempt happened
    expect(outcome.reasons).toEqual(["MERGE_REJECTED_PRECONDITION_SHA_OR_STATE"]);
    expect(merge.calls.length).toBe(1); // zero retry
  });

  it("12. backend network ambiguity -> UNKNOWN_REQUIRES_HUMAN_REVIEW, zero retry", async () => {
    const approved = await fingerprintFor(evidence());
    const merge = new RecordingMergeAdapter(NETWORK_AMBIGUOUS);
    const read = new ScriptedReadAdapter([
      evidence(),
      evidence(), // post-validation read still shows OPEN -> not proven
    ]);
    const outcome = await executeApprovedPullRequestMerge(
      { ...BASE, approval: { approved: true, proposalFingerprint: approved } },
      { adapter: read, mergeAdapter: merge },
    );
    expect(outcome.status).toBe("UNKNOWN_REQUIRES_HUMAN_REVIEW");
    expect(outcome.mutationPerformed).toBe(true);
    expect(merge.calls.length).toBe(1); // NO retry, ever
  });

  it("13. backend accepted + post-validation proves MERGED -> VERIFIED", async () => {
    const approved = await fingerprintFor(evidence());
    const merge = new RecordingMergeAdapter(ACCEPTED);
    const read = new ScriptedReadAdapter([
      evidence(),
      evidence({ state: "MERGED", headSha: SHA_B }), // independent fresh proof
    ]);
    const outcome = await executeApprovedPullRequestMerge(
      { ...BASE, approval: { approved: true, proposalFingerprint: approved } },
      { adapter: read, mergeAdapter: merge },
    );
    expect(outcome.status).toBe("VERIFIED");
    expect(outcome.mutationPerformed).toBe(true);
    expect(outcome.evidence?.state).toBe("MERGED");
  });

  it("14. backend accepted but post-validation does NOT prove merge -> UNKNOWN_REQUIRES_HUMAN_REVIEW", async () => {
    const approved = await fingerprintFor(evidence());
    const merge = new RecordingMergeAdapter(ACCEPTED);
    const read = new ScriptedReadAdapter([
      evidence(), // revalidation
      evidence({ state: "OPEN" }), // independent read: still OPEN -> not proven
    ]);
    const outcome = await executeApprovedPullRequestMerge(
      { ...BASE, approval: { approved: true, proposalFingerprint: approved } },
      { adapter: read, mergeAdapter: merge },
    );
    expect(outcome.status).toBe("UNKNOWN_REQUIRES_HUMAN_REVIEW");
    expect(outcome.reasons).toContain("POST_VALIDATION_NOT_PROVEN");
  });

  it("15. post-validation read fails/indeterminate -> UNKNOWN_REQUIRES_HUMAN_REVIEW", async () => {
    const approved = await fingerprintFor(evidence());
    for (const afterMerge of [null, evidence({ state: null })]) {
      const merge = new RecordingMergeAdapter(ACCEPTED);
      const read = new ScriptedReadAdapter([evidence(), afterMerge]);
      const outcome = await executeApprovedPullRequestMerge(
        { ...BASE, approval: { approved: true, proposalFingerprint: approved } },
        { adapter: read, mergeAdapter: merge },
      );
      expect(outcome.status).toBe("UNKNOWN_REQUIRES_HUMAN_REVIEW");
      expect(merge.calls.length).toBe(1); // still exactly one attempt, no retry
    }
  });

  it("16. tokens/credentials never appear in outputs; single-attempt invariants hold", async () => {
    const approved = await fingerprintFor(evidence());
    const merge = new RecordingMergeAdapter(ACCEPTED);
    const read = new ScriptedReadAdapter([evidence(), evidence({ state: "MERGED" })]);
    const outcomes: ExecutedMergeOutcome[] = [];
    outcomes.push(
      await executeApprovedPullRequestMerge(
        { ...BASE, execute: false },
        { adapter: read, mergeAdapter: merge },
      ),
      await executeApprovedPullRequestMerge(
        { ...BASE, approval: { approved: false, proposalFingerprint: approved } },
        { adapter: read, mergeAdapter: merge },
      ),
      await executeApprovedPullRequestMerge(
        { ...BASE, approval: { approved: true, proposalFingerprint: approved } },
        { adapter: read, mergeAdapter: merge },
      ),
    );
    for (const outcome of outcomes) {
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toMatch(/ghp_|gho_|ghu_|ghs_|ghr_|github_pat_/i);
      expect(serialized).not.toMatch(/authorization|bearer/i);
    }
    // Exactly one merge attempt happened across all executions above (only the
    // valid approved one), proving gates consumed zero mutation surface.
    expect(merge.calls.length).toBe(1);
  });

  it("17. no arbitrary mutation surface: governed-only exports and methods", async () => {
    const domain = await import("../src/executeApprovedPullRequestMerge");
    const domainExports = Object.keys(domain);
    expect(domainExports.sort()).toEqual(["executeApprovedPullRequestMerge"]);
    const { GitHubPullRequestMergeAdapter } = await import("../src/githubPullRequestMergeAdapter");
    const prototypeMethods = Object.getOwnPropertyNames(GitHubPullRequestMergeAdapter.prototype)
      .filter((name) => name !== "constructor")
      .sort();
    // The ONLY write-capable method on the adapter is the governed merge itself.
    const writeMethods = prototypeMethods.filter((name) =>
      /merge|update|create|close|delete|patch|put|post|push|approve|execute/i.test(name),
    );
    expect(writeMethods).toEqual(["mergePullRequest"]);
  });
});

describe("GH-00 real merge adapter HTTP shape (mocked fetch)", () => {
  const fixedFetch: (captured: Array<{ method: string; url: string; body: string }>) => GithubFetch =
    (captured) => async (url, init) => {
      captured.push({ method: init.method, url, body: init.body ?? "" });
      return { ok: true, status: 200, json: async () => ({ merged: true }) };
    };

  it("9+10. real adapter uses PUT on the fixed merge endpoint with sha precondition payload", async () => {
    const captured: Array<{ method: string; url: string; body: string }> = [];
    const adapter = new GitHubPullRequestMergeAdapter({
      token: "x".repeat(30),
      fetchImpl: fixedFetch(captured),
    });
    const outcome = await adapter.mergePullRequest({
      repository: REPO,
      pullRequestNumber: 1,
      expectedHeadSha: SHA_A,
    });
    expect(outcome.result).toBe("ACCEPTED");
    expect(captured.length).toBe(1);
    expect(captured[0]?.method).toBe("PUT");
    expect(captured[0]?.url).toBe(`https://api.github.com/repos/${REPO}/pulls/1/merge`);
    const body = JSON.parse(captured[0]?.body ?? "{}") as { sha?: string; merge_method?: string };
    expect(body.sha).toBe(SHA_A); // native SHA precondition present
    expect(body.merge_method).toBe("merge");
  });

  it("9b. adapter rejects malformed precondition without any HTTP call (fail-closed)", async () => {
    const captured: Array<{ method: string; url: string; body: string }> = [];
    const adapter = new GitHubPullRequestMergeAdapter({
      token: "x".repeat(30),
      fetchImpl: fixedFetch(captured),
    });
    const outcome = await adapter.mergePullRequest({
      repository: REPO,
      pullRequestNumber: 1,
      expectedHeadSha: "not-a-sha",
    });
    expect(outcome.result).toBe("REJECTED");
    expect(captured.length).toBe(0);
  });
});
