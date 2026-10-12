/**
 * Read and change a brain's write modes. The owner is the WorkOS user who
 * connected the brain. Everyone who can read the brain can see the modes.
 * Changing a mode is not itself a git write, so read_only cannot lock the owner out.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { requireBrain } from '../auth/access.js';
import { workosUserId } from '../auth/workos.js';
import { db } from '../db/client.js';
import {
  assertCanEditModes,
  describeWriteModes,
  resolveWriteModes,
  withWriteMode,
  WRITE_ACTIONS,
  type WriteModes,
} from '../writes/modes.js';
import { errorResult, handling, textResult } from './shared.js';
import type { ToolContext } from './index.js';

const modeArg = z.enum(['auto', 'review', 'read_only']);

const brainArg = z.string().optional().describe('Brain id, e.g. "owner/repo". Omit when you have exactly one brain.');

export async function saveWriteModes(brainId: string, modes: WriteModes): Promise<void> {
  await db().query('update brains set write_modes = $2::jsonb where id = $1', [brainId, JSON.stringify(modes)]);
}

export function registerSettingsTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_write_modes',
    {
      title: 'Show write modes',
      description:
        'Show how remember, update_fact, and forget behave on a brain. auto commits to the default branch, review opens a pull request, read_only refuses. The default is review.',
      inputSchema: z.object({ brain: brainArg }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handling(async (args, mcp) => {
      const brain = await requireBrain(workosUserId(mcp.http?.authInfo), args.brain);
      const modes = resolveWriteModes(brain.write_modes);
      return textResult(describeWriteModes(brain.id, modes), { brain: brain.id, write_modes: modes });
    }),
  );

  server.registerTool(
    'set_write_mode',
    {
      title: 'Change write modes',
      description:
        'Change how writes behave on a brain you own. Set any of remember, update_fact, forget to auto (commit to the default branch), review (open a pull request), or read_only (refuse). Takes effect on the next call. Only the brain owner can change this.',
      inputSchema: z.object({
        brain: brainArg,
        remember: modeArg.optional().describe('Mode for remember.'),
        update_fact: modeArg.optional().describe('Mode for update_fact.'),
        forget: modeArg.optional().describe('Mode for forget.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    handling(async (args, mcp) => {
      const userId = workosUserId(mcp.http?.authInfo);
      const brain = await requireBrain(userId, args.brain);
      assertCanEditModes(brain, userId);

      const patch: Partial<WriteModes> = {};
      for (const action of WRITE_ACTIONS) {
        const value = args[action];
        if (value) patch[action] = value;
      }
      if (Object.keys(patch).length === 0) {
        return errorResult('Name at least one of remember, update_fact, or forget.');
      }

      const modes = withWriteMode(brain.write_modes, patch);
      await saveWriteModes(brain.id, modes);
      return textResult(`Updated write modes on ${brain.id}.\n\n${describeWriteModes(brain.id, modes)}`, {
        brain: brain.id,
        write_modes: modes,
      });
    }),
  );

  void ctx;
}
