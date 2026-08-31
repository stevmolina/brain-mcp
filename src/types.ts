export interface BrainRow {
  id: string;
  owner_workos_user_id: string;
  owner_github_login: string;
  repo_owner: string;
  repo_name: string;
  default_branch: string;
  installation_id: string | null;
  profile: unknown;
  last_indexed_commit: string | null;
  last_indexed_at: Date | null;
}

export interface ClaimRow {
  id: string;
  brain_id: string;
  text: string;
  page_path: string;
  line: number;
  heading: string | null;
  authority: string | null;
  verified_at: Date | null;
  commit_sha: string;
  superseded_by: string | null;
}

export interface SourceRow {
  id: string;
  brain_id: string;
  path: string;
  sha256: string;
  bytes: number;
  origin: string | null;
  received_at: Date | null;
  commit_sha: string;
}

/** What every tool returns for a claim: text plus where it came from, when it was
 * verified, and its authority. Never a bare string. */
export interface ClaimView {
  id: string;
  brain: string;
  text: string;
  page: string;
  line: number;
  heading: string | null;
  /** null means durable: an unmarked claim, never chased. */
  authority: string | null;
  verified_at: string | null;
  commit: string;
  superseded_by: string | null;
  url: string;
}
