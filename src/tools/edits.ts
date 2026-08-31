/**
 * Pure markdown edits. These take page content in and give page content back, so
 * every write tool's behaviour is testable without touching GitHub.
 */
import { normalizeClaimText } from '../indexer/parse.js';

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const MARKER = /<!--\s*[\s\S]*?\s*-->/;

export interface Marker {
  authority?: string | null;
  verifiedAt?: string | null;
  supersedes?: string | null;
}

export function renderMarker(marker: Marker): string {
  const fields: string[] = [];
  if (marker.authority) fields.push(`authority: ${marker.authority}`);
  if (marker.verifiedAt) fields.push(`verified_at: ${marker.verifiedAt}`);
  if (marker.supersedes) fields.push(`supersedes: ${marker.supersedes}`);
  return fields.length ? `<!-- ${fields.join(' | ')} -->` : '';
}

export function renderClaim(text: string, marker: Marker, indent = ''): string {
  const rendered = renderMarker(marker);
  const body = `${indent}- ${text.trim()}`;
  return rendered ? `${body}\n${indent}  ${rendered}` : body;
}

/** The 1-indexed lines a claim occupies: its list item plus continuation lines. */
export function claimBlock(lines: string[], startLine: number): { start: number; end: number } {
  const start = startLine - 1;
  const opener = lines[start] ?? '';
  const indent = (opener.match(LIST_ITEM)?.[1] ?? '').length;
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') break;
    if (LIST_ITEM.test(line) && (line.match(LIST_ITEM)?.[1] ?? '').length <= indent) break;
    if (line.search(/\S/) <= indent) break;
    end = i;
  }
  return { start, end };
}

/**
 * Finds a claim in a page by its normalized text, preferring `hintLine`.
 * Pages drift between an index rebuild and a write; this keeps a write from
 * landing on the wrong line rather than trusting the stored line number.
 */
export function locateClaim(content: string, claimText: string, hintLine?: number): number | null {
  const lines = content.split(/\r?\n/);
  const wanted = normalizeClaimText(claimText);

  const matches = (line: number): boolean => {
    if (line < 1 || line > lines.length) return false;
    const opener = lines[line - 1]!;
    if (!LIST_ITEM.test(opener)) return false;
    const block = claimBlock(lines, line);
    const raw = lines.slice(block.start, block.end + 1).join('\n').replace(LIST_ITEM, '');
    return normalizeClaimText(raw) === wanted;
  };

  if (hintLine && matches(hintLine)) return hintLine;
  for (let i = 1; i <= lines.length; i++) if (matches(i)) return i;
  return null;
}

/** Appends a claim under `heading`, creating the heading and page body if absent. */
export function appendClaim(
  content: string,
  heading: string,
  text: string,
  marker: Marker,
): string {
  const lines = content === '' ? [] : content.split(/\r?\n/);
  const headingPattern = new RegExp(`^#{1,6}\\s+${escapeRegExp(heading)}\\s*#*\\s*$`, 'i');

  let headingIndex = lines.findIndex((line) => headingPattern.test(line));

  if (headingIndex === -1) {
    while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
    if (lines.length) lines.push('');
    lines.push(`## ${heading}`, '');
    headingIndex = lines.length - 2;
  }

  // Insert at the end of this heading's section, before the next heading.
  let insertAt = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i]!)) {
      insertAt = i;
      break;
    }
  }
  while (insertAt > headingIndex + 1 && lines[insertAt - 1]!.trim() === '') insertAt--;

  const block = renderClaim(text, marker).split('\n');
  // A heading is always followed by a blank line before its first claim.
  if (insertAt === headingIndex + 1) block.unshift('');
  lines.splice(insertAt, 0, ...block);

  const result = lines.join('\n');
  return result.endsWith('\n') ? result : `${result}\n`;
}

/** Replaces a claim's block in place, keeping its indentation. */
export function replaceClaim(
  content: string,
  atLine: number,
  text: string,
  marker: Marker,
): string {
  const lines = content.split(/\r?\n/);
  const block = claimBlock(lines, atLine);
  const indent = lines[block.start]!.match(LIST_ITEM)?.[1] ?? '';
  const replacement = renderClaim(text, marker, indent).split('\n');
  lines.splice(block.start, block.end - block.start + 1, ...replacement);
  return lines.join('\n');
}

/** Removes a claim's block, collapsing the blank line it leaves behind. */
export function removeClaim(content: string, atLine: number): string {
  const lines = content.split(/\r?\n/);
  const block = claimBlock(lines, atLine);
  lines.splice(block.start, block.end - block.start + 1);
  if (
    block.start > 0 &&
    block.start < lines.length &&
    lines[block.start - 1]!.trim() === '' &&
    lines[block.start]!.trim() === ''
  ) {
    lines.splice(block.start, 1);
  }
  return lines.join('\n');
}

/** Reads an existing claim's marker, so an update can keep what it does not change. */
export function readMarker(content: string, atLine: number): Marker {
  const lines = content.split(/\r?\n/);
  const block = claimBlock(lines, atLine);
  const raw = lines.slice(block.start, block.end + 1).join('\n');
  const match = raw.match(MARKER);
  if (!match) return {};
  const inner = match[0].replace(/^<!--\s*/, '').replace(/\s*-->$/, '');
  const marker: Marker = {};
  for (const field of inner.split('|')) {
    const at = field.indexOf(':');
    if (at === -1) continue;
    const key = field.slice(0, at).trim().toLowerCase();
    const value = field.slice(at + 1).trim();
    if (key === 'authority') marker.authority = value;
    if (key === 'verified_at') marker.verifiedAt = value;
    if (key === 'supersedes') marker.supersedes = value;
  }
  return marker;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
