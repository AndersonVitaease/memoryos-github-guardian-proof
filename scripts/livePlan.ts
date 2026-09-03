/**
 * GH-00 — MANUAL READ-ONLY live proof runner.
 *
 * Usage: npx tsx scripts/livePlan.ts <owner/repository> <pullRequestNumber>
 *
 * Performs ONLY the read-only PLAN (evidence fetch -> prechecks -> snapshot ->
 * fingerprint) against the real GitHub API. No merge, no write, no PR creation.
 *
 * Credential is operator configuration: GITHUB_GUARDIAN_TOKEN from the
 * environment. It is never printed, returned or persisted by this script.
 */
import { GITHUB_GUARDIAN_TOKEN_ENV, GitHubPullRequestAdapter } from "../src/githubPullRequestAdapter";
import { planPullRequestMerge } from "../src/planPullRequestMerge";

async function main(): Promise<void> {
  const [repository, pullRequestNumberRaw] = process.argv.slice(2);
  if (!repository || !/^\d+$/.test(pullRequestNumberRaw ?? "")) {
    console.log("LIVE_PROOF=BLOCKED_OTHER reason=USAGE npx tsx scripts/livePlan.ts <owner/repo> <prNumber>");
    return;
  }
  const token = process.env[GITHUB_GUARDIAN_TOKEN_ENV];
  if (!token) {
    console.log(`LIVE_PROOF=BLOCKED_MISSING_GITHUB_GUARDIAN_TOKEN (set ${GITHUB_GUARDIAN_TOKEN_ENV} as operator config)`);
    return;
  }

  const adapter = new GitHubPullRequestAdapter({ token });
  const outcome = await planPullRequestMerge({
    repository,
    pullRequestNumber: Number(pullRequestNumberRaw),
  }, { adapter });

  // outcome carries evidence and reasons only; it never carries credentials.
  console.log(JSON.stringify({
    LIVE_PROOF: outcome.status,
    mutationPerformed: outcome.mutationPerformed,
    proposalFingerprint: outcome.proposalFingerprint ?? null,
    evidence: outcome.evidence,
    reasons: outcome.reasons,
  }, null, 2));
}

main().catch(() => {
  console.log("LIVE_PROOF=BLOCKED_OTHER reason=LIVE_PLAN_ERROR");
});
