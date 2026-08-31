import { isoDay } from '../dates.js';
import type { BrainRow, ClaimRow, ClaimView } from '../types.js';

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
    verified_at: isoDay(row.verified_at),
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

/**
 * Wraps a tool handler so an authorization refusal comes back as a tool error
 * the caller can read and act on, rather than as a transport failure. A caller
 * who named the wrong brain, or who has more than one, needs to be told which,
 * not handed a 500.
 */
export function handling<A, C, R>(
  handler: (args: A, ctx: C) => Promise<R>,
): (args: A, ctx: C) => Promise<R | ReturnType<typeof errorResult>> {
  return async (args, ctx) => {
    try {
      return await handler(args, ctx);
    } catch (error) {
      if (error instanceof ToolRefusal) return errorResult(error.message);
      throw error;
    }
  };
}

/** A refusal the caller should see verbatim: no brain, wrong brain, refused write. */
export class ToolRefusal extends Error {}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
