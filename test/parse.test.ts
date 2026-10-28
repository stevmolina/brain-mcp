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

describe('supersession markers', () => {
  it('reads a supersedes prefix off an updated claim', () => {
    const [claim] = parse(
      ['- The revised wording.', '  <!-- authority: live | verified_at: 2026-08-31 | supersedes: 8eb428c6620d594e -->'].join('\n'),
    );
    expect(claim?.supersedes).toEqual(['8eb428c6620d594e']);
    // The id must not depend on the marker, or updating a claim twice would
    // change what the earlier marker points at.
    expect(claim?.id).toBe(claimId('test/brain', 'wiki/scope.md', 'The revised wording.'));
  });

  it('reads several supersedes targets from one marker', () => {
    const [claim] = parse('- Merged claim. <!-- supersedes: aaaaaaaa, bbbbbbbb -->');
    expect(claim?.supersedes).toEqual(['aaaaaaaa', 'bbbbbbbb']);
  });
});

describe('table rows', () => {
  const ledger = [
    '## Decisions',
    '',
    '| Date | Status | Decision |',
    '|------|:------:|----------|',
    '| 2026-09-08 | Active | Invoice weekly. |',
    '| 2026-09-15 | Dropped | Skip the pilot. |',
    '',
    '- A list item after the table.',
  ].join('\n');

  it('turns each body row into one claim, header paired with cells', () => {
    const claims = parse(ledger);
    expect(claims.map((c) => c.text)).toEqual([
      'Date: 2026-09-08; Status: Active; Decision: Invoice weekly.',
      'Date: 2026-09-15; Status: Dropped; Decision: Skip the pilot.',
      'A list item after the table.',
    ]);
  });

  it('skips the header and separator, and records heading and line', () => {
    const claims = parse(ledger);
    expect(claims[0]?.line).toBe(5);
    expect(claims[1]?.line).toBe(6);
    expect(claims[0]?.heading).toBe('Decisions');
    expect(claims.some((c) => c.text.includes('---') || c.text === 'Date: Date')).toBe(false);
  });

  it('works without outer pipes', () => {
    const claims = parse(['Owner | Task', '--- | ---', 'Ana | Ship the form'].join('\n'));
    expect(claims.map((c) => c.text)).toEqual(['Owner: Ana; Task: Ship the form']);
  });

  it('leaves out empty cells', () => {
    const [claim] = parse(['| Name | Note | Owner |', '|---|---|---|', '| Plan B | | Ana |'].join('\n'));
    expect(claim?.text).toBe('Name: Plan B; Owner: Ana');
  });

  it('keeps an escaped pipe inside a cell', () => {
    const [claim] = parse(['| Term | Meaning |', '|---|---|', '| a\\|b | either one |'].join('\n'));
    expect(claim?.text).toBe('Term: a|b; Meaning: either one');
  });

  it('falls back to the raw cells when the column counts differ', () => {
    const [claim] = parse(['| A | B |', '|---|---|', '| one | two | three |'].join('\n'));
    expect(claim?.text).toBe('one | two | three');
  });

  it('falls back to the raw cells when the header cells are all empty', () => {
    const [claim] = parse(['| | |', '|---|---|', '| left | right |'].join('\n'));
    expect(claim?.text).toBe('left | right');
  });

  it('ignores tables inside fenced code', () => {
    const claims = parse(['```md', '| A | B |', '|---|---|', '| 1 | 2 |', '```'].join('\n'));
    expect(claims).toEqual([]);
  });

  it('does not treat a lone pipe line as a table', () => {
    expect(parse('a | b\nplain prose')).toEqual([]);
  });

  it('parses a marker in a cell like a list-item marker and strips it', () => {
    const [claim] = parse(
      [
        '| Item | State |',
        '|---|---|',
        '| Hosting | Live <!-- authority: live | verified_at: 2026-08-19 | supersedes: abc12345 --> |',
      ].join('\n'),
    );
    expect(claim?.text).toBe('Item: Hosting; State: Live');
    expect(claim?.authority).toBe('live');
    expect(claim?.verifiedAt).toBe('2026-08-19');
    expect(claim?.supersedes).toEqual(['abc12345']);
    expect(claim?.id).toBe(claimId('test/brain', 'wiki/scope.md', 'Item: Hosting; State: Live'));
  });

  it('reads a marker that sits in its own trailing column', () => {
    const [claim] = parse(
      ['| Item | State |', '|---|---|', '| Hosting | Live | <!-- authority: derived --> |'].join('\n'),
    );
    expect(claim?.text).toBe('Item: Hosting; State: Live');
    expect(claim?.authority).toBe('derived');
  });

  it('turns links under the sources dir into provenance edges', () => {
    const [claim] = parse(
      [
        '| Fact | Evidence |',
        '|---|---|',
        '| Rate is fixed | [contract](../sources/raw/contract.pdf) and [site](https://example.com/x) |',
      ].join('\n'),
    );
    expect(claim?.sourcePaths).toEqual(['sources/raw/contract.pdf']);
  });

  it('reads a source marker path from the repo root', () => {
    const [claim] = parse(
      ['| Fact | Note |', '|---|---|', '| Rate is fixed | ok <!-- source: sources/raw/a.pdf --> |'].join('\n'),
    );
    expect(claim?.sourcePaths).toEqual(['sources/raw/a.pdf']);
  });

  it('keeps ids stable and unique per row, and leaves list-item ids alone', () => {
    const claims = parse(ledger);
    expect(claims[0]?.id).toBe(
      claimId('test/brain', 'wiki/scope.md', 'Date: 2026-09-08; Status: Active; Decision: Invoice weekly.'),
    );
    expect(new Set(claims.map((c) => c.id)).size).toBe(claims.length);
    expect(claims[2]?.id).toBe(claimId('test/brain', 'wiki/scope.md', 'A list item after the table.'));
  });

  it('ends the table at a heading or blank line and resumes list parsing', () => {
    const claims = parse(['| A | B |', '|---|---|', '| 1 | 2 |', '# Next', '- bullet'].join('\n'));
    expect(claims.map((c) => [c.text, c.heading])).toEqual([
      ['A: 1; B: 2', null],
      ['bullet', 'Next'],
    ]);
  });

  it('leaves a table indented under a list item as part of that item', () => {
    const claims = parse(['- Pricing tiers:', '  | Tier | Price |', '  |------|-------|', '  | A | 10 |', '  Agreed.'].join('\n'));
    expect(claims.map((c) => c.text)).toEqual(['Pricing tiers: | Tier | Price | |------|-------| | A | 10 | Agreed.']);
  });

  it('ends the table at a list item, even one with a pipe', () => {
    const claims = parse(['| A | B |', '|---|---|', '| 1 | 2 |', '- item with a | pipe'].join('\n'));
    expect(claims.map((c) => c.text)).toEqual(['A: 1; B: 2', 'item with a | pipe']);
  });

  it('ignores a repeated separator row', () => {
    const claims = parse(['| A | B |', '|---|---|', '|---|---|', '| 1 | 2 |'].join('\n'));
    expect(claims.map((c) => c.text)).toEqual(['A: 1; B: 2']);
  });
});
