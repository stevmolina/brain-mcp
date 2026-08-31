import type { BrainRow, ClaimRow, ClaimView } from '../types.js';

function isoDate(value: Date | string | null): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/**
 * Every returned claim carries where it came from, when it was verified, and its
 * authority. This is the only place a claim row becomes a tool result, so there
 * is no path by which a bare sentence reaches a caller.
 */
export function toClaimView(brain: BrainRow, row: ClaimRow): ClaimView {
  return {
    id: row.id,
    brain: brain.id,
    text: row.text,
    page: row.page_path,
    line: row.line,
    heading: row.heading,
    authority: row.authority,
    verified_at: isoDate(row.verified_at),
    commit: row.commit_sha,
    superseded_by: row.superseded_by,
    // Page paths carry spaces and other characters GitHub needs percent-encoded,
    // and the link is the whole point of returning provenance.
    url:
      `https://github.com/${brain.repo_owner}/${brain.repo_name}/blob/${row.commit_sha}/` +
      `${row.page_path.split('/').map(encodeURIComponent).join('/')}#L${row.line}`,
  };
}

export function renderClaimLine(view: ClaimView): string {
  const authority = view.authority ? `authority: ${view.authority}` : 'durable';
  const verified = view.verified_at ? `, verified ${view.verified_at}` : '';
  const superseded = view.superseded_by ? `, SUPERSEDED by ${view.superseded_by.slice(0, 12)}` : '';
  return `- ${view.text}\n  ${view.page}:${view.line} (${authority}${verified}${superseded}) [${view.id.slice(0, 12)}]`;
}

export function textResult(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true as const,
  };
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
