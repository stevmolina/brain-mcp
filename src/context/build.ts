/**
 * `context`: everything an agent should know before answering one question,
 * in one call and within a character budget. It walks four levels and stops
 * when the budget is spent or a level answers the question:
 *
 *   1. me card   the caller's own personal page (profile `meCard`)
 *   2. index     the target brain's map page (profile `indexPage`)
 *   3. claims    two-tier search over the target brains
 *   4. chats     the caller's own chats filed under those brains
 *
 * Every line carries a date, so the reader can tell old from new.
 *
 * Brains come only from requireBrain (an explicit `brain`) or accessibleBrains
 * (everything else), so this module never widens what a caller can read.
 */
import { accessibleBrains, githubLoginForWorkosUser, isBrainOwner, requireBrain } from '../auth/access.js';
import { resolveProfile } from '../profiles/index.js';
import { searchClaims, type ClaimHit } from '../search/claims.js';
import { sessionsEnabled } from '../sessions/db.js';
import { sessionsForQuestion, type SessionSummary } from '../sessions/store.js';
import { toClaimView } from '../tools/shared.js';
import type { BrainRow, ClaimView } from '../types.js';
import { readBrainPage, type BrainPage, type PageReader } from './pages.js';

export const CONTEXT_HEADER =
  'Newest dated fact wins. If Slack, mail, a call or a file is newer than a line here, it wins; write it back to the brain.';

export interface ContextInput {
  question: string;
  brain?: string;
  cwd?: string;
  budget?: number;
  depth?: number;
}

export interface ContextPage extends BrainPage {
  brain: string;
  truncated: boolean;
}

export interface ContextResult {
  question: string;
  header: string;
  brains: string[];
  brain_choice: 'explicit' | 'alias' | 'search' | 'none';
  budget: number;
  used: number;
  depth: number;
  /** The last level that ran, and why the walk stopped there. */
  stopped_at: number;
  stopped_because: 'depth' | 'budget' | 'answered' | 'done';
  me: ContextPage | null;
  index: ContextPage[];
  claims: ClaimView[];
  sessions: SessionSummary[];
  /** The whole result as one block of text, what an agent or a hook injects. */
  text: string;
}

export interface ContextDeps {
  readPage?: PageReader;
}

const DEFAULT_BUDGET = 6000;
/** Repo names too generic to pick a brain from a question by themselves. */
const GENERIC_NAMES = new Set(['brain', 'brains', 'knowledge', 'notes', 'wiki', 'docs', 'memory']);

export async function buildContext(userId: string, input: ContextInput, deps: ContextDeps = {}): Promise<ContextResult> {
  const readPage = deps.readPage ?? readBrainPage;
  const question = input.question.trim();
  const budget = Math.max(1000, Math.min(input.budget ?? DEFAULT_BUDGET, 40_000));
  const depth = Math.max(1, Math.min(input.depth ?? 4, 4));
  const explicitDepth = input.depth !== undefined;

  const reachable = input.brain ? null : await accessibleBrains(userId);
  const { brains, how } = input.brain
    ? { brains: [await requireBrain(userId, input.brain)], how: 'explicit' as const }
    : await chooseBrains(reachable!, question, input.cwd);

  const shown = question.length > 200 ? `${question.slice(0, 200)}...` : question;
  const parts: string[] = [`# Context for: ${shown}`, CONTEXT_HEADER];
  let used = parts.join('\n').length;
  const room = () => budget - used;
  const add = (block: string) => {
    parts.push(block);
    used += block.length + 1;
  };

  const result: Omit<ContextResult, 'text' | 'used'> = {
    question,
    header: CONTEXT_HEADER,
    brains: brains.map((b) => b.id),
    brain_choice: how,
    budget,
    depth,
    stopped_at: 0,
    stopped_because: 'done',
    me: null,
    index: [],
    claims: [],
    sessions: [],
  };
  add(brains.length ? `Brains: ${brains.map((b) => b.id).join(', ')} (chosen by ${how}).` : 'Brains: none matched this question.');

  // Level 1: the caller's own me card, from a personal brain they own.
  result.stopped_at = 1;
  const personal = await personalBrain(userId, reachable ?? (await accessibleBrains(userId)));
  if (personal) {
    const page = await readPage(personal, resolveProfile(personal.profile).meCard!).catch(() => null);
    if (page) {
      const head = `\n## Me card (${personal.id} ${page.path}, updated ${page.updated_at ?? 'undated'})\n`;
      const trimmed = trimPage(page.text, Math.min(Math.floor(budget * 0.25), room()) - head.length - 1);
      if (trimmed.text) {
        result.me = { ...page, brain: personal.id, text: trimmed.text, truncated: trimmed.truncated };
        add(head + trimmed.text);
      }
    }
  }
  if (depth < 2) return finish('depth');
  if (room() < 200) return finish('budget');

  // Level 2: each target brain's index page, sharing a fifth of the budget.
  result.stopped_at = 2;
  for (const brain of brains) {
    const path = resolveProfile(brain.profile).indexPage;
    const page = await readPage(brain, path).catch(() => null);
    if (!page) continue;
    const head = `\n## Index of ${brain.id} (${page.path}, updated ${page.updated_at ?? 'undated'})\n`;
    const trimmed = trimPage(page.text, Math.min(Math.floor((budget * 0.2) / brains.length), room() - 100) - head.length - 1);
    if (!trimmed.text) continue;
    result.index.push({ ...page, brain: brain.id, text: trimmed.text, truncated: trimmed.truncated });
    add(head + trimmed.text);
  }
  if (depth < 3) return finish('depth');
  if (room() < 200) return finish('budget');

  // Level 3: claims. Leaves a little room for chats when level 4 may run.
  result.stopped_at = 3;
  // A brain's own name picks the brain; its claims rarely repeat it, so it
  // would only lower their coverage.
  const searchText = withoutNames(question, brains) || question;
  const hits: ClaimHit[] = await searchClaims(brains.map((b) => b.id), searchText, { limit: 20 });
  const reserve = depth >= 4 && sessionsEnabled() ? Math.floor(budget * 0.15) : 0;
  const byId = new Map(brains.map((b) => [b.id, b]));
  const lines: string[] = [];
  // Room for the heading and the "No matching claims." line, counted up front.
  used += 60;
  for (const hit of hits) {
    const view = toClaimView(byId.get(hit.brain_id)!, hit);
    const line = claimLine(view, brains.length > 1);
    if (line.length + 1 > room() - reserve) break;
    result.claims.push(view);
    lines.push(line);
    used += line.length + 1;
  }
  parts.push(`\n## Claims (${result.claims.length} of ${hits.length} found)`, ...(lines.length ? lines : ['No matching claims.']));
  const strict = result.claims.filter((c) => c.match === 'all_words').length;
  if (depth < 4) return finish('depth');
  if (!sessionsEnabled()) return finish('done');
  if (!explicitDepth && strict >= 3) return finish('answered');
  if (room() < 150) return finish('budget');

  // Level 4: the caller's own chats in those brains. Never anyone else's.
  result.stopped_at = 4;
  try {
    const chats = await sessionsForQuestion(userId, brains.map((b) => b.id), searchText, 5);
    const chatsHead = '\n## Your chats (private to you)';
    used += chatsHead.length + 1;
    const chatLines: string[] = [];
    for (const chat of chats) {
      const line = sessionLine(chat);
      if (line.length + 1 > room()) break;
      result.sessions.push(chat);
      chatLines.push(line);
      used += line.length + 1;
    }
    if (chatLines.length) parts.push(chatsHead, ...chatLines);
  } catch (error) {
    console.error(JSON.stringify({ level: 'warn', at: 'context.sessions', message: String(error) }));
  }
  return finish('done');

  function finish(reason: ContextResult['stopped_because']): ContextResult {
    const text = parts.join('\n');
    return { ...result, stopped_because: reason, used: text.length, text };
  }
}

/**
 * Explicit `brain` wins (handled by the caller). Then brains named in the
 * question or the cwd hint, by a profile alias or the repo name. Then the
 * brains whose claims match the question best. At most two.
 */
export async function chooseBrains(
  reachable: BrainRow[],
  question: string,
  cwd?: string,
): Promise<{ brains: BrainRow[]; how: 'alias' | 'search' | 'none' }> {
  const haystack = ` ${question} ${cwd ?? ''} `.toLowerCase();
  const scored = reachable
    .map((brain) => {
      const names = brainNames(brain);
      const hits = names.filter((name) => mentions(haystack, name));
      return { brain, score: hits.reduce((sum, name) => sum + name.length, 0) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length) return { brains: scored.slice(0, 2).map((s) => s.brain), how: 'alias' };

  const hits = await searchClaims(reachable.map((b) => b.id), question, { limit: 30 });
  const score = new Map<string, number>();
  for (const hit of hits) {
    const weight = (hit.covered / Math.max(hit.terms, 1)) * (hit.match === 'all_words' ? 2 : 1);
    score.set(hit.brain_id, (score.get(hit.brain_id) ?? 0) + weight);
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (!ranked.length) return { brains: [], how: 'none' };
  const byId = new Map(reachable.map((b) => [b.id, b]));
  return { brains: ranked.map(([id]) => byId.get(id)!), how: 'search' };
}

function brainNames(brain: BrainRow): string[] {
  const profile = resolveProfile(brain.profile);
  const repo = brain.repo_name.toLowerCase();
  const fromRepo = [repo, repo.replace(/-knowledge$/, '')].filter((name) => !GENERIC_NAMES.has(name));
  return [...new Set([...profile.aliases.map((a) => a.toLowerCase()), ...fromRepo])].filter((n) => n.length >= 3);
}

/** The question with the chosen brains' names taken out. */
function withoutNames(question: string, brains: BrainRow[]): string {
  let text = ` ${question} `;
  for (const name of brains.flatMap(brainNames).sort((a, b) => b.length - a.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'gi'), '$1');
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** Whole-word match, so "art" does not pick a brain from "start". */
function mentions(haystack: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(haystack);
}

/** The caller's own brain with a me card. Owned, not merely readable. */
async function personalBrain(userId: string, reachable: BrainRow[]): Promise<BrainRow | null> {
  const candidates = reachable.filter((b) => resolveProfile(b.profile).meCard);
  if (!candidates.length) return null;
  const login = await githubLoginForWorkosUser(userId).catch(() => null);
  return candidates.find((b) => isBrainOwner(b, userId, login)) ?? null;
}

/** Keeps whole lines up to `max` characters. */
export function trimPage(text: string, max: number): { text: string; truncated: boolean } {
  const clean = text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  if (max <= 0) return { text: '', truncated: clean.length > 0 };
  if (clean.length <= max) return { text: clean, truncated: false };
  const note = '\n[trimmed: read the page for the rest]';
  const lines = clean.split('\n');
  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 + note.length > max) break;
    out += (out ? '\n' : '') + line;
  }
  return { text: out ? out + note : '', truncated: true };
}

function claimLine(view: ClaimView, showBrain: boolean): string {
  const date = view.verified_at
    ? `verified ${view.verified_at}`
    : view.page_updated_at
      ? `page updated ${view.page_updated_at}`
      : 'undated';
  const where = `${showBrain ? `${view.brain} ` : ''}${view.page}:${view.line}`;
  const some = view.match === 'any_words' ? `, some words ${view.coverage}` : '';
  const authority = view.authority ? `, ${view.authority}` : '';
  return `- ${view.text.replace(/\s+/g, ' ')} [${date}${authority}; ${where}${some}; ${view.id.slice(0, 12)}]`;
}

function sessionLine(chat: SessionSummary): string {
  const at = (chat.card_updated_at ?? chat.updated_at ?? chat.started_at)?.slice(0, 10) ?? 'undated';
  const about = (chat.card || chat.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return `- ${chat.title} [chat, updated ${at}; ${chat.source}:${chat.id}]${about ? `\n  ${about}` : ''}`;
}
