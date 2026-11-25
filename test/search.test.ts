/**
 * Two-tier claim search. Invented brains only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { claimId } from '../src/indexer/parse.js';
import { searchClaims } from '../src/search/claims.js';
import { renderClaimLine, toClaimView } from '../src/tools/shared.js';

const A = 'search-test/orchard';
const B = 'search-test/harbor';
const C = 'search-test/ranking';

interface Seed {
  text: string;
  page?: string;
  heading?: string | null;
  verified?: string | null;
}

async function seed(brain: string, claims: Seed[], pageDates: Record<string, string> = {}) {
  await db().query(
    `insert into brains (id, owner_workos_user_id, owner_github_login, repo_owner, repo_name)
     values ($1, 'user_search_test', 'search-test', 'search-test', $2)`,
    [brain, brain.split('/')[1]],
  );
  let line = 1;
  for (const claim of claims) {
    const page = claim.page ?? 'wiki/index.md';
    await db().query(
      `insert into claims (id, brain_id, text, page_path, line, heading, verified_at, commit_sha)
       values ($1, $2, $3, $4, $5, $6, $7, 'cafe')`,
      [claimId(brain, page, claim.text), brain, claim.text, page, line++, claim.heading ?? null, claim.verified ?? null],
    );
  }
  for (const [path, at] of Object.entries(pageDates)) {
    await db().query('insert into pages (brain_id, path, last_commit_at) values ($1, $2, $3)', [brain, path, at]);
  }
}

beforeAll(async () => {
  await migrate();
  await db().query('delete from brains where id in ($1, $2, $3)', [A, B, C]);
  await seed(
    A,
    [
      { text: 'Milestone 2 demo is on 2026-12-03 with the orchard board.', page: 'wiki/milestones.md', heading: 'Acceptance' },
      { text: 'Milestone 2 demo moved once already.', page: 'wiki/milestones.md', heading: 'History' },
      { text: 'Invoices go out on the first business day.', page: 'wiki/billing.md' },
      { text: 'The demo laptop lives in the cupboard.', page: 'wiki/office.md' },
      { text: 'Old note about the date of the picnic.', page: 'wiki/old.md' },
      { text: 'New note about the date of the picnic.', page: 'wiki/new.md' },
      { text: 'Pears are picked by hand.', page: 'wiki/harvest/pears.md' },
      { text: '`com.orchard.nightly-sync` copies the ledger every night.', page: 'wiki/jobs.md' },
      { text: 'Verified picnic date is in June.', page: 'wiki/old.md', verified: '2026-11-01' },
    ],
    { 'wiki/old.md': '2026-01-01T00:00:00Z', 'wiki/new.md': '2026-11-20T00:00:00Z' },
  );
  await seed(C, [
    { text: 'Order notes for the 22 depots missing from the carrier files; status partial.', page: 'wiki/log-a.md', verified: '2026-11-01' },
    { text: 'Open carrier files were reviewed for depot paperwork again.', page: 'wiki/log-b.md', verified: '2026-11-20' },
    { text: 'Open carrier files were reviewed for depot paperwork in round two.', page: 'wiki/asks.md', verified: '2026-11-02' },
    { text: 'Open carrier files were reviewed for depot paperwork in round three.', page: 'wiki/log-c.md', verified: '2026-11-21' },
  ]);
  await seed(B, [{ text: 'Milestone 2 demo date for the harbor is secret: 2026-12-24.', page: 'wiki/milestones.md' }]);
});

afterAll(async () => {
  await db().query('delete from brains where id in ($1, $2, $3)', [A, B, C]);
  await closeDb();
});

describe('search tiers', () => {
  it('finds a claim by its heading words, not only its own text', async () => {
    const hits = await searchClaims([A], 'milestone acceptance', { limit: 5 });
    expect(hits[0]!.text).toMatch(/2026-12-03/);
    expect(hits[0]!.match).toBe('all_words');
  });

  it('finds a claim by its page path', async () => {
    const hits = await searchClaims([A], 'harvest pears', { limit: 5 });
    expect(hits.map((h) => h.text)).toEqual(['Pears are picked by hand.']);
  });

  it('finds the parts of a dotted name', async () => {
    const hits = await searchClaims([A], 'orchard nightly ledger', { limit: 5 });
    expect(hits[0]!.text).toMatch(/nightly-sync/);
    expect(hits[0]!.match).toBe('all_words');
  });

  it('falls back to some-words matching when no claim has every word', async () => {
    // "date" is in no milestone claim, so the strict tier finds nothing.
    const hits = await searchClaims([A], 'Milestone 2 acceptance demo date', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.match === 'any_words')).toBe(true);
    // The claim covering the most query words ranks first.
    expect(hits[0]!.text).toMatch(/2026-12-03/);
    expect(hits[0]!.covered).toBeGreaterThan(hits[hits.length - 1]!.covered);
  });

  it('keeps strict hits first and fills the rest from the loose tier', async () => {
    const hits = await searchClaims([A], 'milestone demo', { limit: 10 });
    const tiers = hits.map((h) => h.match);
    expect(tiers.indexOf('any_words')).toBeGreaterThan(tiers.lastIndexOf('all_words'));
    expect(new Set(hits.map((h) => h.id)).size).toBe(hits.length);
  });

  it('does not run the loose tier when the strict tier fills the limit', async () => {
    const hits = await searchClaims([A], 'milestone demo', { limit: 2 });
    expect(hits.map((h) => h.match)).toEqual(['all_words', 'all_words']);
  });

  it('matches word prefixes in the loose tier', async () => {
    const hits = await searchClaims([A], 'invoic cupboards', { limit: 5 });
    expect(hits.map((h) => h.text)).toEqual(
      expect.arrayContaining(['Invoices go out on the first business day.', 'The demo laptop lives in the cupboard.']),
    );
  });

  it('ignores a query of stopwords only', async () => {
    expect(await searchClaims([A], 'the of and', { limit: 5 })).toEqual([]);
  });

  it('survives query punctuation that tsquery would reject', async () => {
    await expect(searchClaims([A], "pears' & (picnic | ! :*", { limit: 5 })).resolves.toBeInstanceOf(Array);
  });

  it('ranks verified claims, then newer pages, first among equals', async () => {
    const hits = await searchClaims([A], 'picnic date', { limit: 5 });
    expect(hits.map((h) => h.text)).toEqual([
      'Verified picnic date is in June.',
      'New note about the date of the picnic.',
      'Old note about the date of the picnic.',
    ]);
    expect(hits[1]!.page_updated_at?.toISOString().slice(0, 10)).toBe('2026-11-20');
  });

  it('marks the tier and coverage on the claim view and line', async () => {
    const [hit] = await searchClaims([A], 'Milestone 2 acceptance demo date', { limit: 1 });
    const view = toClaimView({ id: A, repo_owner: 'search-test', repo_name: 'orchard' }, hit!);
    expect(view.match).toBe('any_words');
    expect(view.coverage).toMatch(/^\d\/5$/);
    expect(renderClaimLine(view)).toContain('{some words:');
  });
});

describe('ranking', () => {
  it('drops filler words, so the other words can all match', async () => {
    const hits = await searchClaims([C], 'What is still open with the carrier files?', { limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.match).toBe('all_words');
  });

  it('keeps a question made only of filler', async () => {
    await expect(searchClaims([C], 'still', { limit: 5 })).resolves.toBeInstanceOf(Array);
  });

  it('counts a number: the row with it beats rows that cover the same other words', async () => {
    const hits = await searchClaims([C], 'open 22 carrier depots', { limit: 10 });
    expect(hits[0]!.text).toMatch(/22 depots/);
  });

  it('puts register rows ahead of newer rows with the same coverage', async () => {
    const plain = await searchClaims([C], 'open carrier files reviewed paperwork round', { limit: 10 });
    expect(plain[0]!.page_path).not.toBe('wiki/asks.md');
    const hits = await searchClaims([C], 'open carrier files reviewed paperwork round', {
      limit: 10,
      registers: [{ brainId: C, path: 'wiki/asks.md' }],
    });
    expect(hits[0]!.page_path).toBe('wiki/asks.md');
  });

  it('ignores a register for a brain it was not asked to search', async () => {
    const hits = await searchClaims([A], 'milestone demo', { limit: 5, registers: [{ brainId: B, path: 'wiki/milestones.md' }] });
    expect(hits.every((h) => h.brain_id === A)).toBe(true);
  });
});

describe('search isolation', () => {
  it('never returns another brain\'s claim, in either tier', async () => {
    for (const query of ['secret harbor', 'harbor milestone demo date secret', 'Milestone 2 demo']) {
      const hits = await searchClaims([A], query, { limit: 20 });
      expect(hits.every((h) => h.brain_id === A), query).toBe(true);
      expect(JSON.stringify(hits)).not.toContain('2026-12-24');
    }
  });

  it('searches only the brains it is given', async () => {
    expect(await searchClaims([], 'milestone', { limit: 5 })).toEqual([]);
    const both = await searchClaims([A, B], 'harbor secret', { limit: 5 });
    expect(both.map((h) => h.brain_id)).toEqual([B]);
  });
});
