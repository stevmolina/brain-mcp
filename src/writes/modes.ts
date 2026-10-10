/**
 * How a write lands, per action, per brain.
 *
 * review is the default, so a brain that has never set a mode keeps opening
 * pull requests. auto commits to the default branch. read_only refuses.
 * Unknown keys and unknown values are ignored so a bad row cannot escalate.
 */
import { ToolRefusal } from '../tools/shared.js';
import type { BrainRow } from '../types.js';

export const WRITE_ACTIONS = ['remember', 'update_fact', 'forget'] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];
export type WriteMode = 'auto' | 'review' | 'read_only';
export type WriteModes = Record<WriteAction, WriteMode>;

export const DEFAULT_WRITE_MODES: WriteModes = {
  remember: 'review',
  update_fact: 'review',
  forget: 'review',
};

const MODE_VALUES = new Set<WriteMode>(['auto', 'review', 'read_only']);

export function resolveWriteModes(stored: unknown): WriteModes {
  const raw = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const modes: WriteModes = { ...DEFAULT_WRITE_MODES };
  for (const action of WRITE_ACTIONS) {
    const value = raw[action];
    if (typeof value === 'string' && MODE_VALUES.has(value as WriteMode)) modes[action] = value as WriteMode;
  }
  return modes;
}

export function resolveWriteMode(stored: unknown, action: WriteAction): WriteMode {
  return resolveWriteModes(stored)[action];
}

/** Patch is applied on top of the saved modes. Omitted actions stay as they are. */
export function withWriteMode(stored: unknown, patch: Partial<WriteModes>): WriteModes {
  const modes = resolveWriteModes(stored);
  for (const action of WRITE_ACTIONS) {
    const value = patch[action];
    if (value) modes[action] = value;
  }
  return modes;
}

export function assertCanEditModes(brain: BrainRow, workosUserId: string): void {
  if (brain.owner_workos_user_id !== workosUserId) {
    throw new ToolRefusal(`Only the owner of ${brain.id} can change write modes.`);
  }
}

export const MODE_HELP: Record<WriteMode, string> = {
  auto: 'Commit to the default branch and reindex immediately. Revert from git history.',
  review: 'Open a pull request. Approve it to save.',
  read_only: 'Refuse the write.',
};

export function describeWriteModes(brainId: string, stored: unknown): string {
  const modes = resolveWriteModes(stored);
  const lines = [`Write modes for ${brainId}`, ''];
  for (const action of WRITE_ACTIONS) {
    lines.push(`${action}: ${modes[action]}`);
  }
  lines.push(
    '',
    `auto: ${MODE_HELP.auto}`,
    `review: ${MODE_HELP.review}`,
    `read_only: ${MODE_HELP.read_only}`,
    '',
    'The owner changes these with set_write_mode.',
  );
  return lines.join('\n');
}
