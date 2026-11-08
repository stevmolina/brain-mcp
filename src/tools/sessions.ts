/**
 * Session tools: your own agent chats, and chats someone shared with you.
 *
 * Two stores stay separate. A brain belongs to a team and follows GitHub repo
 * access. Sessions belong to one person and stay private unless that person
 * shares one. Every read here goes through src/sessions/store.ts, which returns
 * a chat only to its owner or to the verified email of an active share.
 */
import { z } from 'zod';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { requireBrain } from '../auth/access.js';
import { verifiedEmailOf, workosProfile } from '../auth/identity.js';
import { workosUserId } from '../auth/workos.js';
import { loadConfig } from '../config.js';
import { WriteRefused } from '../github/write.js';
import { resolveProfile } from '../profiles/index.js';
import {
  AmbiguousSession,
  createShare,
  describePlan,
  listMyShares,
  listSharedWithMe,
  openSession,
  planShare,
  revokeShare,
  searchSessions,
  ShareRefused,
  type OpenedSession,
  type SessionSummary,
  type ShareView,
} from '../sessions/store.js';
import { appendClaim } from './edits.js';
import { brainArg, errorResult, handling, textResult, today, ToolRefusal } from './shared.js';
import { describeWrite, landEdit } from './write.js';

const sessionArg = z.string().min(4).describe('Chat id from search_sessions (or source:id), or a share id from list_shared_with_me.');
const sourceArg = z.string().optional().describe('Only needed when two of your chats share an id: claude, codex, cursor, t3code, chatgpt, claude-ai, grok.');
const dayArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

/** Budget for one show_session result. Long chats page with from_turn. */
const SHOW_CHAR_BUDGET = 60_000;

export function shareLink(shareId: string): string {
  return `${new URL(loadConfig().mcpResourceUrl).origin}/s/${shareId}`;
}

async function callerOf(mcp: ServerContext) {
  const userId = workosUserId(mcp.http?.authInfo);
  return { userId, email: await verifiedEmailOf(userId) };
}

function day(value: string | null): string {
  return value ? value.slice(0, 10) : 'undated';
}

export function renderSummary(s: SessionSummary): string {
  const where = s.brain ? ` · ${s.brain}` : '';
  const tool = s.provider && s.provider !== s.source ? `${s.source}/${s.provider}` : s.source;
  const lines = [`- ${s.title}`, `  ${s.source}:${s.id} · ${tool} · ${day(s.updated_at ?? s.started_at)} · ${s.turn_count} turns${where}`];
  if (s.snippet) lines.push(`  ${s.snippet.slice(0, 320)}`);
  return lines.join('\n');
}

function renderShare(share: ShareView): string {
  const range = share.turn_from || share.turn_to ? `turns ${share.turn_from ?? 1}-${share.turn_to ?? 'end'}` : 'whole chat';
  const expiry = share.expires_at ? `expires ${share.expires_at.slice(0, 10)}` : 'no expiry';
  return `- ${share.title ?? share.session_id} -> ${share.with} (${range}, ${expiry}, ${share.status})\n  share ${share.id} · ${shareLink(share.id)}`;
}

/** Renders the turns of an opened chat within a character budget. */
export function renderOpened(opened: OpenedSession): { text: string; next: number | null } {
  const header = [
    `${opened.title}`,
    `${opened.source}:${opened.id} · ${opened.provider} · ${day(opened.started_at)} · ${opened.brain ?? 'no brain'}`,
    opened.access === 'shared'
      ? `Shared with you (turns ${opened.allowed.from}-${opened.allowed.to} of ${opened.turn_count}). Read only.`
      : `Your chat, ${opened.turn_count} turns.`,
    '',
  ];
  let used = header.join('\n').length;
  const parts: string[] = [];
  let last = opened.window.from - 1;
  for (const [index, turn] of opened.turns.entries()) {
    const number = opened.window.from + index;
    const block = `--- turn ${number} · ${turn.role} ---\n${turn.text}\n`;
    if (parts.length > 0 && used + block.length > SHOW_CHAR_BUDGET) break;
    parts.push(block.length > SHOW_CHAR_BUDGET ? `${block.slice(0, SHOW_CHAR_BUDGET)}\n[turn cut at ${SHOW_CHAR_BUDGET} characters]\n` : block);
    used += block.length;
    last = number;
  }
  const next = last < opened.allowed.to ? last + 1 : null;
  const footer = next ? `\nMore turns: call show_session again with from_turn=${next}.` : '\nEnd of what you can see.';
  return { text: header.join('\n') + parts.join('\n') + footer, next };
}

function refused(error: unknown) {
  if (error instanceof ShareRefused || error instanceof AmbiguousSession || error instanceof WriteRefused) {
    return errorResult(error.message);
  }
  throw error;
}

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    'search_sessions',
    {
      title: 'Search your chats',
      description:
        'Search your own past agent chats (Claude Code, Codex, Cursor, T3, imported ChatGPT, Claude.ai and Grok) when earlier context would help: a decision, a prior attempt, what was already tried. ' +
        'Only your chats, never anyone else\'s. An empty query lists the most recent. Filter by `brain` (the project the chat ran in), `tool`, and dates.',
      inputSchema: z.object({
        query: z.string().default('').describe('Words to search for. Empty lists the most recent chats.'),
        brain: z.string().optional().describe('Only chats tagged with this brain id, e.g. "owner/repo".'),
        tool: z.string().optional().describe('Only chats from this tool: claude, codex, cursor, t3code, grok, chatgpt, claude-ai.'),
        since: dayArg.describe('Only chats active on or after this day (YYYY-MM-DD).'),
        until: dayArg.describe('Only chats started on or before this day (YYYY-MM-DD).'),
        limit: z.number().int().min(1).max(50).default(15),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handling(async (args, mcp) => {
      const { userId } = await callerOf(mcp);
      const hits = await searchSessions(userId, args);
      const header = `${hits.length} of your chat${hits.length === 1 ? '' : 's'}${args.query ? ` for "${args.query}"` : ', most recent first'}`;
      const body = hits.length ? hits.map(renderSummary).join('\n') : 'No matching chats.';
      return textResult(`${header}\n\n${body}\n\nOpen one with show_session.`, { sessions: hits });
    }),
  );

  server.registerTool(
    'show_session',
    {
      title: 'Show a chat',
      description:
        'Open one chat from search_sessions to read its turns, or a chat someone shared with you (pass the share id or the chat id). ' +
        'Long chats come back in pages; follow from_turn.',
      inputSchema: z.object({
        session: sessionArg,
        source: sourceArg,
        from_turn: z.number().int().min(1).optional().describe('First turn to show, 1-based.'),
        max_turns: z.number().int().min(1).max(200).default(40),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handling(async (args, mcp) => {
      const caller = await callerOf(mcp);
      try {
        const opened = await openSession(caller, args, { from: args.from_turn, max: args.max_turns });
        if (!opened) return errorResult(`No chat ${args.session} is available to you.`);
        const { text, next } = renderOpened(opened);
        const { turns: _turns, ownerId: _owner, ...meta } = opened;
        return textResult(text, { session: meta, next_from_turn: next });
      } catch (error) {
        return refused(error);
      }
    }),
  );

  server.registerTool(
    'list_shared_with_me',
    {
      title: 'Chats shared with you',
      description: 'List chats other people shared with you. Open one with show_session and its share id.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handling(async (_args, mcp) => {
      const caller = await callerOf(mcp);
      if (!caller.email) {
        return textResult('Your sign-in has no verified email, so no shares can reach you.', { shares: [] });
      }
      const shares = await listSharedWithMe(caller.email);
      const named = await Promise.all(
        shares.map(async ({ ownerId, ...share }) => ({ ...share, owner: (await workosProfile(ownerId))?.name ?? 'someone' })),
      );
      const body = named.length
        ? named.map((s) => `- ${s.title} (from ${s.owner})\n  share ${s.id} · ${shareLink(s.id)}`).join('\n')
        : 'Nothing is shared with you.';
      return textResult(`Shared with ${caller.email}:\n\n${body}`, { shares: named });
    }),
  );

  server.registerTool(
    'share_session',
    {
      title: 'Share a chat',
      description:
        'Share one of your chats, or a turn range of it, with one person by email, when the user asks to send or show a chat to someone. ' +
        'First call it without confirm to get a preview, show the preview to the user, and call again with confirm=true only after they agree. ' +
        'The person signs in as that email to read it, at the link returned, or through their own AI with show_session. Revoke with revoke_share.',
      inputSchema: z.object({
        session: sessionArg,
        source: sourceArg,
        with: z.string().min(3).describe('The email address of the person to share with.'),
        from_turn: z.number().int().min(1).optional().describe('Share from this turn (1-based). Omit for the start.'),
        to_turn: z.number().int().min(1).optional().describe('Share up to this turn, inclusive. Omit for the end.'),
        expires: z
          .union([z.string(), z.number()])
          .optional()
          .describe('A day (YYYY-MM-DD), a number of days, or "never". Defaults to 30 days.'),
        note: z.string().max(500).optional().describe('A short note the person sees with the chat.'),
        confirm: z.boolean().default(false).describe('false returns a preview and creates nothing. true creates the share.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handling(async (args, mcp) => {
      const { userId } = await callerOf(mcp);
      try {
        const plan = await planShare(userId, {
          session: args.session,
          source: args.source,
          email: args.with,
          turnFrom: args.from_turn,
          turnTo: args.to_turn,
          expires: args.expires,
          note: args.note,
        });
        const preview = describePlan(plan);
        if (!args.confirm) {
          return textResult(`PREVIEW, nothing shared yet.\n\n${preview}\n\nShow this to the user. Call again with confirm=true to share.`, {
            preview: true,
            session: plan.session,
            with: plan.email,
            turn_from: plan.turnFrom,
            turn_to: plan.turnTo,
            expires_at: plan.expiresAt?.toISOString() ?? null,
          });
        }
        const share = await createShare(plan);
        return textResult(
          [`Shared. ${plan.email} can open it after signing in:`, shareLink(share.id), '', preview, '', `Revoke with revoke_share share=${share.id}.`].join('\n'),
          { preview: false, share, link: shareLink(share.id) },
        );
      } catch (error) {
        return refused(error);
      }
    }),
  );

  server.registerTool(
    'revoke_share',
    {
      title: 'Revoke a share',
      description: 'Stop a person from reading a chat you shared. Takes effect on their next request.',
      inputSchema: z.object({ share: z.string().min(8).describe('Share id from share_session or list_my_shares.') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    handling(async (args, mcp) => {
      const { userId } = await callerOf(mcp);
      const done = await revokeShare(userId, args.share);
      return done
        ? textResult(`Revoked share ${args.share}. The link no longer opens.`, { revoked: true })
        : errorResult(`No active share ${args.share} of yours.`);
    }),
  );

  server.registerTool(
    'list_my_shares',
    {
      title: 'Your shares',
      description: 'List the chats you have shared, with whom, and whether each share is active, expired or revoked.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handling(async (_args, mcp) => {
      const { userId } = await callerOf(mcp);
      const shares = await listMyShares(userId);
      return textResult(shares.length ? shares.map(renderShare).join('\n') : 'You have not shared any chats.', { shares });
    }),
  );

  server.registerTool(
    'save_to_brain',
    {
      title: 'Save a chat decision to a brain',
      description:
        'When a chat settled a durable decision or fact, record it in the project\'s brain as a claim that cites the chat. ' +
        'Write the claim as one plain sentence. Goes through the same path as remember: a pull request, or a direct commit for an owner with direct writes on; the result says which. ' +
        'The brain defaults to the one the chat is tagged with.',
      inputSchema: z.object({
        session: sessionArg,
        source: sourceArg,
        text: z.string().min(3).describe('The claim, as one sentence.'),
        turn: z.number().int().min(1).optional().describe('The turn where it was decided, to cite.'),
        brain: brainArg,
        page: z.string().optional().describe('Markdown page. Defaults to the brain profile page.'),
        heading: z.string().optional().describe('Heading to append under. Created if absent.'),
        authority: z.string().optional().describe('e.g. "live". Leave off for a durable fact.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    handling(async (args, mcp) => {
      const caller = await callerOf(mcp);
      try {
        const opened = await openSession(caller, args, { from: args.turn, max: 1 });
        if (!opened) return errorResult(`No chat ${args.session} is available to you.`);
        if (args.turn && (args.turn < opened.allowed.from || args.turn > opened.allowed.to)) {
          return errorResult(`turn must be between ${opened.allowed.from} and ${opened.allowed.to}.`);
        }
        const brainId = args.brain ?? opened.brain ?? undefined;
        const brain = await requireBrain(caller.userId, brainId);
        const profile = resolveProfile(brain.profile);
        const page = args.page ?? profile.writePage;
        const heading = args.heading ?? profile.writeHeading;
        const cite = `${opened.source}:${opened.id}${args.turn ? `#turn-${args.turn}` : ''}`;
        const verifiedAt = args.authority ? today() : null;
        const chat = `"${opened.title}" (${opened.source}, ${day(opened.started_at)}${args.turn ? `, turn ${args.turn}` : ''})`;
        const details = [`Adds one claim to \`${page}\` under **${heading}**, saved from the chat ${chat}.`, `Chat: \`${cite}\``];

        const result = await landEdit(
          brain,
          {
            page,
            branchPrefix: 'brain/from-chat',
            commitMessage: `brain: save a decision from a chat to ${page}`,
            title: `From chat: ${args.text.length > 60 ? `${args.text.slice(0, 59)}…` : args.text}`,
            details,
            body: [...details, '', '---', `Opened by brain-mcp save_to_brain for the \`${brain.id}\` brain.`].join('\n'),
            apply: (content) =>
              appendClaim(content, heading, args.text, { authority: args.authority ?? null, verifiedAt, session: cite }),
          },
          { workosUserId: caller.userId, agent: mcp.http?.req?.headers.get('user-agent')?.slice(0, 80) ?? null },
        );
        return textResult(
          describeWrite(result, {
            committed: `Committed a claim from the chat to ${brain.id}.`,
            proposed: `Proposed a claim from the chat in ${brain.id}.`,
          }),
          { brain: brain.id, session: cite, mode: result.mode },
        );
      } catch (error) {
        if (error instanceof ToolRefusal) throw error;
        return refused(error);
      }
    }),
  );
}
