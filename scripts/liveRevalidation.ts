/**
 * GH-00 — MANUAL READ-ONLY live revalidation runner.
 *
 * Usage:
 *   npx tsx scripts/liveRevalidation.ts <owner/repository> <pullRequestNumber> <approvedFingerprint>
 *
 * Validates an approval fingerprint against the FRESH real GitHub state of the
 * Pull Request (fresh evidence -> same prechecks -> same snapshot -> fingerprint
 * comparison). Returns APPROVED_SNAPSHOT_VALID or SNAPSHOT_CHANGED (or the
 * PLAN BLOCKED/UNKNOWN outcome). NEVER merges, NEVER writes, NEVER creates a PR.
 *
 * Credential is operator configuration: GITHUB_GUARDIAN_TOKEN from the
 * environment. It is never printed, returned or persisted by this script.
 */
import { GITHUB_GUARDIAN_TOKEN_ENV, GitHubPullRequestAdapter } from "../src/githubPullRequestAdapter";
import { prepareApprovedPullRequestMerge } from "../src/prepareApprovedPullRequestMerge";

async function main(): Promise<void> {
  const [repository, pullRequestNumberRaw, approvedFingerprint] = process.argv.slice(2);
  if (!repository || !/^\d+$/.test(pullRequestNumberRaw ?? "")) {
    console.log(
      "LIVE_REVALIDATION=BLOCKED_OTHER reason=USAGE npx tsx scripts/liveRevalidation.ts <owner/repo> <prNumber> <approvedFingerprint>",
    );
    return;
  }
  const token = process.env[GITHUB_GUARDIAN_TOKEN_ENV];
  if (!token) {
    console.log(
      `LIVE_REVALIDATION=BLOCKED_MISSING_GITHUB_GUARDIAN_TOKEN (set ${GITHUB_GUARDIAN_TOKEN_ENV} as operator config)`,
    );
    return;
  }

  const adapter = new GitHubPullRequestAdapter({ token });
  const outcome = await prepareApprovedPullRequestMerge(
    {
      repository,
      pullRequestNumber: Number(pullRequestNumberRaw),
      execute: true,
      approval: { approved: true, proposalFingerprint: approvedFingerprint },
    },
    { adapter },
  );

  // outcome carries evidence and fingerprints only; it never carries credentials.
  console.log(JSON.stringify({
    LIVE_REVALIDATION: outcome.status,
    mutationPerformed: outcome.mutationPerformed,
    approvedFingerprint: outcome.approvedFingerprint ?? null,
    currentFingerprint: outcome.currentFingerprint ?? null,
    evidence: outcome.evidence,
    reasons: outcome.reasons,
  }, null, 2));
}

main().catch(() => {
  console.log("LIVE_REVALIDATION=BLOCKED_OTHER reason=LIVE_REVALIDATION_ERROR");
});
