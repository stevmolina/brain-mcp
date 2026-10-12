import type { BrainRow } from '../types.js';
import type { CreateBrainState } from './state.js';
import type { SeedFile } from './starter.js';

export class OnboardingError extends Error {}

export interface CreatedRepo {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface RepoRef {
  owner: string;
  name: string;
  private: boolean;
}

export interface InsertBrainInput {
  id: string;
  workosUserId: string;
  ownerGithubLogin: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  installationId: number;
}

/**
 * Everything onboarding asks of GitHub and the database.
 * Tests pass a fake. The real one lives in github.ts.
 */
export interface OnboardingIO {
  githubLogin(workosUserId: string): Promise<string | null>;
  installUrl(): Promise<string>;
  callbackUrl(): string;
  oauthConfigured(): boolean;
  mintAuthorizeUrl(state: CreateBrainState): string;
  readState(state: string): CreateBrainState | null;
  userInstallation(login: string): Promise<{ id: number } | null>;
  installationForRepo(owner: string, repo: string): Promise<number | null>;
  canonicalRepo(installationId: number, owner: string, repo: string): Promise<{ owner: string; name: string; defaultBranch: string }>;
  findBrainByRepo(owner: string, name: string): Promise<BrainRow | null>;
  callerCanReadRepo(installationId: number, owner: string, repo: string, login: string): Promise<boolean>;
  headSha(installationId: number, owner: string, repo: string, branch: string): Promise<string>;
  insertBrain(input: InsertBrainInput): Promise<BrainRow | null>;
  indexBrain(brain: BrainRow, sha: string): Promise<void>;
  listRepos(installationId: number): Promise<RepoRef[]>;
  githubLoginForToken(token: string): Promise<string>;
  createPrivateRepo(token: string, name: string): Promise<CreatedRepo>;
  attachRepo(token: string, installationId: number, repoId: number): Promise<void>;
  commitFiles(installationId: number, owner: string, repo: string, branch: string, files: SeedFile[], message: string): Promise<string>;
  exchangeCode(code: string): Promise<string>;
}

export interface OnboardingReply {
  text: string;
  isError?: boolean;
  structured?: Record<string, unknown>;
}

export interface CallbackResult {
  status: number;
  html: string;
}
