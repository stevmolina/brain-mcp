/**
 * Writes on a hosted brain. There is no repo, so the note is saved and
 * reindexed immediately instead of opening a pull request. sources/ is still
 * refused. Git brains do not come through here.
 */
import { db, withTransaction } from '../db/client.js';
import { assertWritablePage, WriteRefused } from '../github/write.js';
import { resolveProfile } from '../profiles/index.js';
import { appendClaim, locateClaim, readMarker, removeClaim, replaceClaim } from '../tools/edits.js';
import { loadClaim } from '../tools/read.js';
import { today, ToolRefusal } from '../tools/shared.js';
import { loadConfig } from '../config.js';
import { FREE_NOTE_LIMIT, TEAM_SAFETY_CAP } from '../billing/plans.js';
import { getAccount, isHostedBrain } from './brain.js';
import { reindexHosted } from './index.js';
import type { BrainRow } from '../types.js';

export class PlanLimit extends ToolRefusal {}

const MAX_NOTE_CHARS = 1000;

export function upgradeMessage(limit = FREE_NOTE_LIMIT): string {
  const origin = new URL(loadConfig().mcpResourceUrl).origin;
  return `Free plan holds ${limit} notes. Upgrade to Team ($10/mo) to keep writing: ${origin}/billing/checkout`;
}

export async function countClaims(brainId: string): Promise<number> {
  const { rows } = await db().query<{ n: number }>('select count(*)::int as n from claims where brain_id = $1', [brainId]);
  return rows[0]?.n ?? 0;
}

/** Refuses a new note when the Free cap (or the Team safety cap) is full. */
export async function assertCanAddNote(brain: BrainRow): Promise<void> {
  if (!isHostedBrain(brain)) return;
  const account = await getAccount(brain.owner_workos_user_id);
  const plan = account?.plan === 'team' ? 'team' : 'free';
  const count = await countClaims(brain.id);
  if (plan === 'team') {
    if (count >= TEAM_SAFETY_CAP) {
      throw new PlanLimit(`This brain has reached the ${TEAM_SAFETY_CAP} note safety cap.`);
    }
    return;
  }
  if (count >= FREE_NOTE_LIMIT) throw new PlanLimit(upgradeMessage());
}

export async function rememberHosted(
  brain: BrainRow,
  input: { text: string; page?: string; heading?: string; authority?: string | null; verifiedAt?: string | null },
): Promise<{ page: string }> {
  const text = input.text.trim();
  if (text.length < 3) throw new WriteRefused('A note needs at least a few words.');
  if (text.length > MAX_NOTE_CHARS) throw new WriteRefused(`Notes stay under ${MAX_NOTE_CHARS} characters.`);
  await assertCanAddNote(brain);

  const profile = resolveProfile(brain.profile);
  const page = input.page ?? profile.writePage;
  const heading = input.heading ?? profile.writeHeading;
  const verifiedAt = input.verifiedAt ?? (input.authority ? today() : null);

  await editPage(brain, page, (content) =>
    appendClaim(content, heading, text, { authority: input.authority ?? null, verifiedAt }),
  );
  return { page };
}

export async function updateHosted(
  brain: BrainRow,
  input: { claimId: string; text?: string; authority?: string | null; verifiedAt?: string | null },
): Promise<{ page: string }> {
  const claim = await loadClaim(brain.id, input.claimId);
  if (!claim) throw new WriteRefused(`No claim ${input.claimId} in ${brain.id}.`);
  const newText = (input.text ?? claim.text).trim();
  if (newText.length < 3) throw new WriteRefused('A note needs at least a few words.');
  if (newText.length > MAX_NOTE_CHARS) throw new WriteRefused(`Notes stay under ${MAX_NOTE_CHARS} characters.`);

  await editPage(brain, claim.page_path, (content) => {
    const line = locateClaim(content, claim.text, claim.line);
    if (line === null) {
      throw new WriteRefused(`Could not find that note in ${claim.page_path}. Search again and retry.`);
    }
    const existing = readMarker(content, line);
    return replaceClaim(content, line, newText, {
      authority: input.authority ?? existing.authority ?? null,
      verifiedAt: input.verifiedAt ?? today(),
      supersedes: claim.id.slice(0, 16),
    });
  });
  return { page: claim.page_path };
}

export async function forgetHosted(brain: BrainRow, claimId: string): Promise<{ page: string }> {
  const claim = await loadClaim(brain.id, claimId);
  if (!claim) throw new WriteRefused(`No claim ${claimId} in ${brain.id}.`);
  await editPage(brain, claim.page_path, (content) => {
    const line = locateClaim(content, claim.text, claim.line);
    if (line === null) throw new WriteRefused(`Could not find that note in ${claim.page_path}. It may already be gone.`);
    return removeClaim(content, line);
  });
  return { page: claim.page_path };
}

async function editPage(brain: BrainRow, page: string, apply: (content: string) => string): Promise<void> {
  assertWritablePage(brain, page);
  await withTransaction(async (client) => {
    const current = await client.query<{ content: string }>(
      'select content from pages where brain_id = $1 and path = $2',
      [brain.id, page],
    );
    const content = current.rows[0]?.content ?? '';
    const next = apply(content);
    if (next === content) throw new WriteRefused(`That change is already the state of ${page}; nothing to do.`);
    await client.query(
      `insert into pages (brain_id, path, content, updated_at) values ($1, $2, $3, now())
       on conflict (brain_id, path) do update set content = excluded.content, updated_at = now()`,
      [brain.id, page, next],
    );
    await reindexHosted(client, brain);
  });
}
