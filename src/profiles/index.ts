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
  /**
   * When true, the brain's owner writes straight to the default branch instead of
   * opening a pull request. Everyone else still gets a pull request. Off unless
   * the stored profile says exactly `true`.
   */
  directWrites: boolean;
  /** The page `context` reads as this brain's map: what is where. */
  indexPage: string;
  /**
   * The owner's "me card": a page about who they are and how they work, which
   * `context` puts first for that owner. Set only on a personal brain.
   */
  meCard: string | null;
  /** Other names for this brain (a client, a product), so `context` can pick
   * it from a question. Data on the brains row, never in code. */
  aliases: string[];
  /**
   * Register pages: paths (relative to the repo root) where this brain keeps
   * rows people look things up in, such as its asks or its known facts. Search
   * and `context` rank their rows ahead of other rows that cover the same
   * words. Default none; data on the brains row, never in code.
   */
  registerPages: string[];
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
  directWrites: false,
  indexPage: 'wiki/index.md',
  meCard: null,
  aliases: [],
  registerPages: [],
};

export function resolveProfile(stored: unknown): BrainProfile {
  const overrides = (stored && typeof stored === 'object' ? stored : {}) as Partial<BrainProfile>;
  const profile: BrainProfile = { ...DEFAULT_PROFILE, ...overrides };
  // A switch that changes who can write to main: only a literal true turns it on,
  // so a stray "false" string or 1 in the jsonb never does.
  profile.directWrites = overrides.directWrites === true;
  profile.indexPage = typeof overrides.indexPage === 'string' && overrides.indexPage ? overrides.indexPage : DEFAULT_PROFILE.indexPage;
  profile.meCard = typeof overrides.meCard === 'string' && overrides.meCard ? overrides.meCard : null;
  profile.aliases = Array.isArray(overrides.aliases)
    ? overrides.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim().length >= 2).map((a) => a.trim())
    : [];
  profile.registerPages = Array.isArray(overrides.registerPages)
    ? overrides.registerPages.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim())
    : [];

  // sources/ is evidence, not claims. The exclusion is structural, not configurable:
  // the write path must never be able to reach it either.
  const sourcesGlob = `${profile.sourcesDir.replace(/\/$/, '')}/**`;
  if (!profile.exclude.includes(sourcesGlob)) {
    profile.exclude = [...profile.exclude, sourcesGlob];
  }
  return profile;
}
