import { describe, expect, it } from 'vitest';
import { claimId, normalizeClaimText, parsePage, resolveRepoPath } from '../src/indexer/parse.js';

const parse = (content: string, pagePath = 'wiki/scope.md') =>
  parsePage({ brainId: 'test/brain', pagePath, content, sourcesDir: 'sources' });

describe('claim parsing', () => {
  it('reads an unmarked list item as a durable claim', () => {
    const [claim] = parse('- The engagement started in March.');
    expect(claim?.text).toBe('The engagement started in March.');
    expect(claim?.authority).toBeNull();
    expect(claim?.verifiedAt).toBeNull();
    expect(claim?.line).toBe(1);
  });

  it('reads authority and verified_at from a marker on the next line', () => {
    const [claim] = parse(
      ["- Production runs in the client's Vercel account.", '  <!-- authority: live | verified_at: 2026-08-19 -->'].join('\n'),
    );
    expect(claim?.text).toBe("Production runs in the client's Vercel account.");
    expect(claim?.authority).toBe('live');
    expect(claim?.verifiedAt).toBe('2026-08-19');
  });

  it('reads a marker on the same line', () => {
    const [claim] = parse('- Billing is monthly. <!-- authority: live | verified_at: 2026-01-02 -->');
    expect(claim?.text).toBe('Billing is monthly.');
    expect(claim?.authority).toBe('live');
  });

  it('rejects a malformed date rather than storing it', () => {
    const [claim] = parse('- A thing. <!-- authority: live | verified_at: last tuesday -->');
    expect(claim?.authority).toBe('live');
    expect(claim?.verifiedAt).toBeNull();
  });

  it('ignores list items inside fenced code', () => {
    const claims = parse(['- Real claim.', '', '```sh', '- not a claim', '```', '', '- Another real claim.'].join('\n'));
    expect(claims.map((c) => c.text)).toEqual(['Real claim.', 'Another real claim.']);
  });

  it('skips frontmatter', () => {
    const claims = parse(['---', 'title: Scope', '- not a claim', '---', '', '- Real claim.'].join('\n'));
    expect(claims.map((c) => c.text)).toEqual(['Real claim.']);
  });

  it('joins continuation lines into one claim', () => {
    const [claim] = parse(['- The deployment target is the client account,', '  not ours.'].join('\n'));
    expect(claim?.text).toBe('The deployment target is the client account, not ours.');
  });

  it('records the heading path', () => {
    const [claim] = parse(['# Scope', '', '## Out of scope', '', '- Mobile is out.'].join('\n'));
    expect(claim?.heading).toBe('Scope > Out of scope');
  });

  it('takes provenance from a markdown link into sources', () => {
    const [claim] = parse('- The SOW caps the retainer. See [the SOW](../sources/raw/sow.pdf).');
    expect(claim?.sourcePaths).toEqual(['sources/raw/sow.pdf']);
  });

  it('takes provenance from an explicit source marker', () => {
    const [claim] = parse('- Retainer is capped. <!-- source: sources/raw/sow.pdf -->');
    expect(claim?.sourcePaths).toEqual(['sources/raw/sow.pdf']);
  });

  it('ignores links that do not point into sources', () => {
    const [claim] = parse('- See [the wiki](./index.md) and [vercel](https://vercel.com).');
    expect(claim?.sourcePaths).toEqual([]);
  });

  it('reads supersedes markers', () => {
    const [claim] = parse('- The new number is 12. <!-- supersedes: abc12345 -->');
    expect(claim?.supersedes).toEqual(['abc12345']);
  });

  it('handles nested and numbered items', () => {
    const claims = parse(['- Parent claim.', '  - Child claim.', '', '1. Numbered claim.'].join('\n'));
    expect(claims.map((c) => c.text)).toEqual(['Parent claim.', 'Child claim.', 'Numbered claim.']);
  });
});

describe('claim identity', () => {
  it('is stable when only whitespace changes', () => {
    const a = claimId('b', 'p.md', 'The  engagement   started.');
    const b = claimId('b', 'p.md', 'The engagement started.');
    expect(a).toBe(b);
  });

  it('is stable when only the marker changes', () => {
    const a = claimId('b', 'p.md', 'A fact. <!-- authority: live | verified_at: 2026-01-01 -->');
    const b = claimId('b', 'p.md', 'A fact. <!-- authority: live | verified_at: 2026-08-01 -->');
    expect(a).toBe(b);
  });

  it('differs across brains for identical text and path', () => {
    expect(claimId('brain-a', 'p.md', 'Same words.')).not.toBe(claimId('brain-b', 'p.md', 'Same words.'));
  });

  it('changes when the claim changes', () => {
    expect(claimId('b', 'p.md', 'Ten seats.')).not.toBe(claimId('b', 'p.md', 'Twelve seats.'));
  });

  it('normalizes markers out of the text', () => {
    expect(normalizeClaimText('A fact. <!-- authority: live -->')).toBe('A fact.');
  });
});

describe('repo path resolution', () => {
  it('resolves relative paths against the page', () => {
    expect(resolveRepoPath('wiki/scope.md', '../sources/raw/a.pdf')).toBe('sources/raw/a.pdf');
    expect(resolveRepoPath('wiki/scope.md', './notes.md')).toBe('wiki/notes.md');
    expect(resolveRepoPath('wiki/scope.md', '/sources/a.pdf')).toBe('sources/a.pdf');
  });

  it('drops anchors and query strings', () => {
    expect(resolveRepoPath('index.md', 'sources/a.md#heading')).toBe('sources/a.md');
  });
});
