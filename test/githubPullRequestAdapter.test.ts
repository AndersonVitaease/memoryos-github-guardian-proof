import { describe, expect, it } from "vitest";

import type { GithubFetch } from "../src/githubPullRequestAdapter";
import { GitHubPullRequestAdapter } from "../src/githubPullRequestAdapter";
import { planPullRequestMerge } from "../src/planPullRequestMerge";

const REPO = "AndersonVitaease/memoryos-github-guardian-proof";
const HEAD_SHA = "abcdef0123".repeat(4);
const FAKE_TOKEN = "gh_super_secret_fake_token_value";

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
}

type Route = (url: string) => { ok: boolean; status: number; json: () => Promise<unknown> };

function mockFetch(route: Route): { fetchImpl: GithubFetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: GithubFetch = async (url, init) => {
    requests.push({ url, method: init.method });
    return route(url);
  };
  return { fetchImpl, requests };
}

function prBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    state: "open",
    merged: false,
    base: { ref: "main" },
    head: { ref: "feature/pr-7", sha: HEAD_SHA },
    mergeable: true,
    mergeable_state: "clean",
    ...overrides,
  };
}

function checkRunsBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total_count: 1,
    check_runs: [{ name: "ci", status: "completed", conclusion: "success" }],
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function standardRoutes(url: string, pr: unknown, checks: unknown) {
  if (url.endsWith(`/pulls/7`)) return jsonResponse(200, pr);
  if (url.includes("/check-runs")) return jsonResponse(200, checks);
  return jsonResponse(500, {});
}

function adapter(fetchImpl: GithubFetch): GitHubPullRequestAdapter {
  return new GitHubPullRequestAdapter({ token: FAKE_TOKEN, apiBaseUrl: "https://api.github.test", fetchImpl });
}

const QUERY = { repository: REPO, pullRequestNumber: 7 };

describe("GH-00 GitHubPullRequestAdapter (real GitHub, READ-ONLY, mocked HTTP)", () => {
  it("1. valid PR + checks response is normalized correctly and reaches PLAN_READY", async () => {
    const { fetchImpl } = mockFetch((url) => standardRoutes(url, prBody(), checkRunsBody()));
    const evidence = await adapter(fetchImpl).getPullRequestEvidence(QUERY);
    expect(evidence).not.toBeNull();
    expect(evidence).toEqual({
      repository: REPO,
      pullRequestNumber: 7,
      state: "OPEN",
      baseBranch: "main",
      headBranch: "feature/pr-7",
      headSha: HEAD_SHA,
      mergeableState: "MERGEABLE",
      checks: [{ name: "ci", conclusion: "SUCCESS" }],
    });
    const outcome = await planPullRequestMerge(QUERY, { adapter: adapter(fetchImpl) });
    expect(outcome.status).toBe("PLAN_READY");
    expect(outcome.proposalFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("2. PR 404 -> null (exists=false), no unsafe exception", async () => {
    const { fetchImpl } = mockFetch((url) =>
      url.endsWith("/pulls/7") ? jsonResponse(404, { message: "Not Found" }) : jsonResponse(200, checkRunsBody()),
    );
    const evidence = await adapter(fetchImpl).getPullRequestEvidence(QUERY);
    expect(evidence).toBeNull();
  });

  it("3. auth/permission error never becomes 'PR not found' -> evidence leads to UNKNOWN", async () => {
    const { fetchImpl } = mockFetch((url) =>
      url.endsWith("/pulls/7") ? jsonResponse(401, { message: "Bad credentials" }) : jsonResponse(200, checkRunsBody()),
    );
    const evidence = await adapter(fetchImpl).getPullRequestEvidence(QUERY);
    expect(evidence).not.toBeNull(); // NOT the 404 contract
    expect(evidence?.state).toBeNull();
    expect(evidence?.mergeableState).toBe("UNKNOWN");
    const outcome = await planPullRequestMerge(QUERY, { adapter: adapter(fetchImpl) });
    expect(outcome.status).toBe("UNKNOWN");
    expect(outcome.mutationPerformed).toBe(false);
  });

  it("4. network/API failure never becomes success -> leads to UNKNOWN", async () => {
    const failingFetch: GithubFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const evidence = await adapter(failingFetch).getPullRequestEvidence(QUERY);
    expect(evidence).not.toBeNull();
    expect(evidence?.state).toBeNull();
    expect(evidence?.checks).toBeNull();
    const outcome = await planPullRequestMerge(QUERY, { adapter: adapter(failingFetch) });
    expect(outcome.status).toBe("UNKNOWN");
  });

  it("5. indeterminate mergeable stays indeterminate (never MERGEABLE)", async () => {
    const { fetchImpl } = mockFetch((url) =>
      standardRoutes(url, prBody({ mergeable: null, mergeable_state: "unknown" }), checkRunsBody()),
    );
    const evidence = await adapter(fetchImpl).getPullRequestEvidence(QUERY);
    expect(evidence?.mergeableState).toBe("UNKNOWN");
    const outcome = await planPullRequestMerge(QUERY, { adapter: adapter(fetchImpl) });
    expect(outcome.status).toBe("UNKNOWN");
    expect(outcome.reasons).toContain("MERGEABLE_STATE_INDETERMINATE");
  });

  it("6. FAILED checks are normalized as FAILED (domain BLOCKED)", async () => {
    const { fetchImpl } = mockFetch((url) =>
      standardRoutes(url, prBody(), checkRunsBody({ check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }] })),
    );
    const evidence = await adapter(fetchImpl).getPullRequestEvidence(QUERY);
    expect(evidence?.checks).toEqual([{ name: "ci", conclusion: "FAILED" }]);
    const outcome = await planPullRequestMerge(QUERY, { adapter: adapter(fetchImpl) });
    expect(outcome.status).toBe("BLOCKED");
    expect(outcome.reasons).toEqual(["CHECKS_FAILED"]);
  });

  it("7. pending/indeterminate checks are never invented as PASS -> UNKNOWN", async () => {
    const { fetchImpl } = mockFetch((url) =>
      standardRoutes(url, prBody(), checkRunsBody({ check_runs: [{ name: "ci", status: "in_progress", conclusion: null }] })),
    );
    const evidence = await adapter(fetchImpl).getPullRequestEvidence(QUERY);
    expect(evidence?.checks).toBeNull();
    const outcome = await planPullRequestMerge(QUERY, { adapter: adapter(fetchImpl) });
    expect(outcome.status).toBe("UNKNOWN");
    expect(outcome.reasons).toEqual(["CHECKS_INDETERMINATE"]);
  });

  it("8. the token never appears in any normalized output or error", async () => {
    const scenarios: Route[] = [
      (url) => standardRoutes(url, prBody(), checkRunsBody()),
      (url) => standardRoutes(url, prBody({ state: "closed" }), checkRunsBody()),
      (url) => standardRoutes(url, prBody({ mergeable: false }), checkRunsBody()),
      (url) => standardRoutes(url, prBody(), checkRunsBody({ check_runs: [{ name: "ci", conclusion: "failure" }] })),
      (url) => standardRoutes(url, prBody({ mergeable: null, mergeable_state: "unknown" }), checkRunsBody()),
    ];
    for (const route of scenarios) {
      const { fetchImpl } = mockFetch(route);
      const evidence = await adapter(fetchImpl).getPullRequestEvidence(QUERY);
      const outcome = await planPullRequestMerge(QUERY, { adapter: adapter(fetchImpl) });
      const serialized = JSON.stringify({ evidence, outcome });
      expect(serialized).not.toContain(FAKE_TOKEN);
      expect(serialized).not.toMatch(/authorization|bearer/i);
    }
  });

  it("9. the adapter allows no write operations at all", async () => {
    const { fetchImpl, requests } = mockFetch((url) => standardRoutes(url, prBody(), checkRunsBody()));
    await adapter(fetchImpl).getPullRequestEvidence(QUERY);
    expect(requests.length).toBe(2);
    for (const request of requests) {
      expect(request.method).toBe("GET");
    }
    const methodNames = Object.getOwnPropertyNames(GitHubPullRequestAdapter.prototype).filter(
      (name) => name !== "constructor",
    );
    // The only public surface is the read-only evidence fetch; no write methods exist.
    for (const name of methodNames) {
      expect(name).not.toMatch(/merge|update|create|close|reopen|approve|execute|patch|post|put|delete/i);
    }
    expect(methodNames).toContain("getPullRequestEvidence");
  });

  it("9b. missing operator token fails closed at construction, naming only the env var", () => {
    expect(() => new GitHubPullRequestAdapter({ token: "" })).toThrowError(/GITHUB_GUARDIAN_TOKEN/);
  });
});
