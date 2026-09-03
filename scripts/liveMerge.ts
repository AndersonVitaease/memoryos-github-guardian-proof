/**
 * GH-00 — MANUAL governed live merge runner (ONE authorized execution).
 *
 * Usage:
 *   npx tsx scripts/liveMerge.ts <owner/repository> <pullRequestNumber> <approvedFingerprint>
 *
 * Full certified cycle against the real GitHub API:
 *   approval gates -> fresh revalidation -> ONE merge attempt with the native
 *   SHA precondition -> independent post-validation.
 * ZERO retry on any failure/ambiguity: ambiguity becomes
 * UNKNOWN_REQUIRES_HUMAN_REVIEW.
 *
 * Credential is operator configuration: GITHUB_GUARDIAN_TOKEN from the
 * environment. It is never printed, returned or persisted by this script.
 */
import { GITHUB_GUARDIAN_TOKEN_ENV, GitHubPullRequestAdapter } from "../src/githubPullRequestAdapter";
import { GitHubPullRequestMergeAdapter } from "../src/githubPullRequestMergeAdapter";
import { executeApprovedPullRequestMerge } from "../src/executeApprovedPullRequestMerge";

async function main(): Promise<void> {
  const [repository, pullRequestNumberRaw, approvedFingerprint] = process.argv.slice(2);
  if (!repository || !/^\d+$/.test(pullRequestNumberRaw ?? "")) {
    console.log(
      "LIVE_MERGE=BLOCKED_OTHER reason=USAGE npx tsx scripts/liveMerge.ts <owner/repo> <prNumber> <approvedFingerprint>",
    );
    return;
  }
  const token = process.env[GITHUB_GUARDIAN_TOKEN_ENV];
  if (!token) {
    console.log(
      `LIVE_MERGE=BLOCKED_MISSING_GITHUB_GUARDIAN_TOKEN (set ${GITHUB_GUARDIAN_TOKEN_ENV} as operator config)`,
    );
    return;
  }

  const outcome = await executeApprovedPullRequestMerge(
    {
      repository,
      pullRequestNumber: Number(pullRequestNumberRaw),
      execute: true,
      approval: { approved: true, proposalFingerprint: approvedFingerprint },
    },
    {
      adapter: new GitHubPullRequestAdapter({ token }),
      mergeAdapter: new GitHubPullRequestMergeAdapter({ token }),
    },
  );

  // outcome carries evidence and fingerprints only; it never carries credentials.
  console.log(JSON.stringify({
    LIVE_MERGE: outcome.status,
    mutationPerformed: outcome.mutationPerformed,
    mergeAttempted: outcome.mergeAttempted,
    approvedFingerprint: outcome.approvedFingerprint ?? null,
    currentFingerprint: outcome.currentFingerprint ?? null,
    evidence: outcome.evidence,
    reasons: outcome.reasons,
  }, null, 2));
}

main().catch(() => {
  console.log("LIVE_MERGE=UNKNOWN_REQUIRES_HUMAN_REVIEW reason=LIVE_MERGE_RUNNER_ERROR");
});
