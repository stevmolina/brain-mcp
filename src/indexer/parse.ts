/**
 * Markdown -> claims.
 *
 * A claim is a markdown list item. Two optional fields ride in a trailing HTML
 * comment, on the item's line or on one of its continuation lines:
 *
 *     - Production runs in the client's Vercel account.
 *       <!-- authority: live | verified_at: 2026-08-19 -->
 *
 * An unmarked list item is a durable claim: authority null, never chased.
 * `authority` says whether the line is truth or a summary of something else.
 * Only a human knows that, which is why it is never derived here.
 *
 * Two further keys are recognised, both optional:
 *   supersedes: <claim id prefix>   -- resolved against the same brain after parsing
 *   source: sources/raw/thing.pdf   -- comma separated; provenance edges
 *
 * Markdown links whose target sits under the brain's sources directory also
 * become provenance edges, so ordinary citation prose needs no marker.
 */
import { createHash } from 'node:crypto';

export interface ParsedClaim {
  id: string;
  text: string;
  pagePath: string;
  /** 1-indexed line of the list item that opened the claim. */
  line: number;
  heading: string | null;
  authority: string | null;
  verifiedAt: string | null;
  supersedes: string[];
  sourcePaths: string[];
}

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```+|~~~+)/;
const MARKER = /<!--\s*([\s\S]*?)\s*-->/;
const MD_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whitespace-collapsed, marker-free text. Used for the claim id, so the id is
 * stable across reflows and marker edits but changes when the claim changes. */
export function normalizeClaimText(text: string): string {
  return text.replace(MARKER, ' ').replace(/\s+/g, ' ').trim();
}

export function claimId(brainId: string, pagePath: string, text: string): string {
  return createHash('sha256')
    .update(`${brainId}\n${pagePath}\n${normalizeClaimText(text)}`)
    .digest('hex');
}

function parseMarker(raw: string): {
  authority: string | null;
  verifiedAt: string | null;
  supersedes: string[];
  sources: string[];
} {
  const out = {
    authority: null as string | null,
    verifiedAt: null as string | null,
    supersedes: [] as string[],
    sources: [] as string[],
  };
  for (const field of raw.split('|')) {
    const at = field.indexOf(':');
    if (at === -1) continue;
    const key = field.slice(0, at).trim().toLowerCase();
    const value = field.slice(at + 1).trim();
    if (!value) continue;
    if (key === 'authority') out.authority = value;
    else if (key === 'verified_at' && ISO_DATE.test(value)) out.verifiedAt = value;
    else if (key === 'supersedes') out.supersedes.push(...value.split(',').map((v) => v.trim()).filter(Boolean));
    else if (key === 'source' || key === 'sources') out.sources.push(...value.split(',').map((v) => v.trim()).filter(Boolean));
  }
  return out;
}

function linkTargets(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(MD_LINK)) {
    const target = match[1];
    if (target && !/^[a-z]+:/i.test(target) && !target.startsWith('#')) found.push(target);
  }
  return found;
}

/** Resolves a link or marker path, written relative to the page, to a repo path. */
export function resolveRepoPath(pagePath: string, target: string): string {
  const clean = target.split('#')[0]!.split('?')[0]!;
  if (!clean) return '';
  if (clean.startsWith('/')) return clean.slice(1);
  const base = pagePath.split('/').slice(0, -1);
  const parts = clean.split('/');
  const stack = [...base];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

export interface ParsePageOptions {
  brainId: string;
  pagePath: string;
  content: string;
  sourcesDir: string;
}

export function parsePage(options: ParsePageOptions): ParsedClaim[] {
  const { brainId, pagePath, content, sourcesDir } = options;
  const sourcePrefix = `${sourcesDir.replace(/\/$/, '')}/`;
  const lines = content.split(/\r?\n/);
  const claims: ParsedClaim[] = [];

  let fence: string | null = null;
  let headings: string[] = [];
  let inFrontmatter = lines[0]?.trim() === '---';

  // Accumulator for the list item currently being read, including continuations.
  let open: { indent: number; line: number; heading: string | null; parts: string[] } | null = null;

  const flush = () => {
    if (!open) return;
    const raw = open.parts.join('\n');
    const marker = raw.match(MARKER);
    const meta = marker ? parseMarker(marker[1]!) : { authority: null, verifiedAt: null, supersedes: [], sources: [] };
    const text = normalizeClaimText(raw);
    if (text) {
      const sourcePaths = [
        // A `source:` marker is metadata, so its path is written from the repo
        // root. A markdown link is prose, so it is relative to the page.
        ...meta.sources.map((s) => (s.startsWith(sourcePrefix) ? s : resolveRepoPath(pagePath, s))),
        ...linkTargets(raw).map((t) => resolveRepoPath(pagePath, t)),
      ].filter((p) => p.startsWith(sourcePrefix));

      claims.push({
        id: claimId(brainId, pagePath, text),
        text,
        pagePath,
        line: open.line,
        heading: open.heading,
        authority: meta.authority,
        verifiedAt: meta.verifiedAt,
        supersedes: meta.supersedes,
        sourcePaths: [...new Set(sourcePaths)],
      });
    }
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (inFrontmatter) {
      if (i > 0 && line.trim() === '---') inFrontmatter = false;
      continue;
    }

    const fenceMatch = line.match(FENCE);
    if (fenceMatch) {
      const ticks = fenceMatch[1]!;
      if (fence === null) {
        flush();
        fence = ticks[0]!;
      } else if (ticks[0] === fence) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;

    const heading = line.match(HEADING);
    if (heading) {
      flush();
      const depth = heading[1]!.length;
      headings = headings.slice(0, depth - 1);
      headings[depth - 1] = heading[2]!.trim();
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      flush();
      open = {
        indent: item[1]!.length,
        line: i + 1,
        heading: headings.filter(Boolean).join(' > ') || null,
        parts: [item[2]!],
      };
      continue;
    }

    if (open) {
      // A continuation line belongs to the open item when it is indented past the
      // bullet and is not blank. A blank line closes the item.
      if (line.trim() === '') flush();
      else if (line.search(/\S/) > open.indent) open.parts.push(line.trim());
      else flush();
      continue;
    }
  }
  flush();

  return claims;
}
