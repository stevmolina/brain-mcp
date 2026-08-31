import { describe, expect, it } from 'vitest';
import {
  appendClaim,
  claimBlock,
  locateClaim,
  readMarker,
  removeClaim,
  renderClaim,
  replaceClaim,
} from '../src/tools/edits.js';
import { parsePage } from '../src/indexer/parse.js';

const page = [
  '# Scope',
  '',
  '## Claims',
  '',
  '- The first claim.',
  '- The second claim.',
  '  <!-- authority: live | verified_at: 2026-01-01 -->',
  '',
  '## Notes',
  '',
  'Prose here.',
  '',
].join('\n');

describe('rendering', () => {
  it('writes the marker on a continuation line', () => {
    expect(renderClaim('A fact.', { authority: 'live', verifiedAt: '2026-08-19' })).toBe(
      '- A fact.\n  <!-- authority: live | verified_at: 2026-08-19 -->',
    );
  });

  it('writes no marker for a durable claim', () => {
    expect(renderClaim('A fact.', {})).toBe('- A fact.');
  });

  it('round-trips through the parser', () => {
    const rendered = renderClaim('A fact.', { authority: 'live', verifiedAt: '2026-08-19' });
    const [claim] = parsePage({ brainId: 'b', pagePath: 'p.md', content: rendered, sourcesDir: 'sources' });
    expect(claim?.text).toBe('A fact.');
    expect(claim?.authority).toBe('live');
    expect(claim?.verifiedAt).toBe('2026-08-19');
  });
});

describe('locating a claim', () => {
  it('finds a claim by text', () => {
    expect(locateClaim(page, 'The second claim.')).toBe(6);
  });

  it('finds a claim whose stored line has drifted', () => {
    expect(locateClaim(page, 'The second claim.', 99)).toBe(6);
  });

  it('returns null when the claim is gone', () => {
    expect(locateClaim(page, 'A claim that was deleted.')).toBeNull();
  });

  it('spans the marker line as part of the claim block', () => {
    expect(claimBlock(page.split('\n'), 6)).toEqual({ start: 5, end: 6 });
  });
});

describe('appending', () => {
  it('appends under an existing heading, before the next one', () => {
    const next = appendClaim(page, 'Claims', 'A third claim.', { authority: 'live', verifiedAt: '2026-08-31' });
    const lines = next.split('\n');
    expect(lines[7]).toBe('- A third claim.');
    expect(lines[8]).toBe('  <!-- authority: live | verified_at: 2026-08-31 -->');
    expect(next).toContain('## Notes');
    expect(next.indexOf('A third claim.')).toBeLessThan(next.indexOf('## Notes'));
  });

  it('creates the heading when absent', () => {
    const next = appendClaim('# Scope\n', 'Claims', 'A claim.', {});
    expect(next).toContain('## Claims');
    expect(next).toContain('- A claim.');
  });

  it('creates the page when it does not exist yet', () => {
    const next = appendClaim('', 'Claims', 'A claim.', {});
    expect(next.trim().split('\n')).toEqual(['## Claims', '', '- A claim.']);
  });

  it('produces a page the parser reads back', () => {
    const next = appendClaim(page, 'Claims', 'A third claim.', { authority: 'live', verifiedAt: '2026-08-31' });
    const claims = parsePage({ brainId: 'b', pagePath: 'wiki/scope.md', content: next, sourcesDir: 'sources' });
    expect(claims.map((c) => c.text)).toEqual(['The first claim.', 'The second claim.', 'A third claim.']);
  });
});

describe('replacing', () => {
  it('replaces the block and keeps a supersedes marker', () => {
    const next = replaceClaim(page, 6, 'The second claim, revised.', {
      authority: 'live',
      verifiedAt: '2026-08-31',
      supersedes: 'abc123',
    });
    expect(next).toContain('- The second claim, revised.');
    expect(next).toContain('<!-- authority: live | verified_at: 2026-08-31 | supersedes: abc123 -->');
    expect(next).not.toContain('verified_at: 2026-01-01');
    expect(next).toContain('- The first claim.');
  });

  it('reads the marker it is about to overwrite', () => {
    expect(readMarker(page, 6)).toEqual({ authority: 'live', verifiedAt: '2026-01-01' });
  });

  it('preserves indentation of a nested claim', () => {
    const nested = '- Parent.\n  - Child.\n';
    expect(replaceClaim(nested, 2, 'Child, revised.', {})).toBe('- Parent.\n  - Child, revised.\n');
  });
});

describe('removing', () => {
  it('removes the claim and its marker', () => {
    const next = removeClaim(page, 6);
    expect(next).not.toContain('The second claim.');
    expect(next).not.toContain('verified_at: 2026-01-01');
    expect(next).toContain('- The first claim.');
    expect(next).toContain('## Notes');
  });

  it('leaves the page parseable', () => {
    const claims = parsePage({
      brainId: 'b',
      pagePath: 'wiki/scope.md',
      content: removeClaim(page, 5),
      sourcesDir: 'sources',
    });
    expect(claims.map((c) => c.text)).toEqual(['The second claim.']);
  });
});
