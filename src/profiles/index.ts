/**
 * Per-brain profile. Everything brain-shaped lives here, so the engine carries no
 * client names, no fixed page names and no house conventions.
 *
 * The profile is stored on the `brains` row as JSONB and merged over these
 * defaults at read time. Deliberately no profile.yaml in tenant repos: adding one
 * waits for a real failure that demands it.
 */

export interface BrainProfile {
  /** Glob patterns, relative to the repo root, whose markdown is parsed for claims. */
  include: string[];
  /** Glob patterns never parsed for claims. `sources/**` is always excluded. */
  exclude: string[];
  /** Directory holding immutable received evidence. Indexed into `sources`, never written. */
  sourcesDir: string;
  /** Default page a `remember` write appends to when the caller names none. */
  writePage: string;
  /** Heading under which a `remember` write appends. Created if absent. */
  writeHeading: string;
  /** Days after which an `authority: live` claim is reported stale by the reconciler. */
  staleLiveDays: number;
}

export const DEFAULT_PROFILE: BrainProfile = {
  include: ['**/*.md'],
  exclude: [
    'node_modules/**',
    '.github/**',
    '**/CHANGELOG.md',
    '**/LICENSE*',
  ],
  sourcesDir: 'sources',
  writePage: 'wiki/index.md',
  writeHeading: 'Claims',
  staleLiveDays: 90,
};

export function resolveProfile(stored: unknown): BrainProfile {
  const overrides = (stored && typeof stored === 'object' ? stored : {}) as Partial<BrainProfile>;
  const profile: BrainProfile = { ...DEFAULT_PROFILE, ...overrides };

  // sources/ is evidence, not claims. The exclusion is structural, not configurable:
  // the write path must never be able to reach it either.
  const sourcesGlob = `${profile.sourcesDir.replace(/\/$/, '')}/**`;
  if (!profile.exclude.includes(sourcesGlob)) {
    profile.exclude = [...profile.exclude, sourcesGlob];
  }
  return profile;
}
