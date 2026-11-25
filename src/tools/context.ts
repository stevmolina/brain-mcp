/**
 * The `context` tool: one call that returns what an agent should read before
 * answering, dated and within a budget. The work is in src/context/build.ts.
 */
import { z } from 'zod';
import type { ToolRegistrar } from './registry.js';
import { workosUserId } from '../auth/workos.js';
import { buildContext } from '../context/build.js';
import { brainArg, handling, textResult } from './shared.js';

export const contextInput = z.object({
  question: z.string().min(1).max(2000).describe('The user\'s question or task, in their words.'),
  brain: brainArg.describe('Brain id to read. Omit to let the question pick (by name, then by best matching claims).'),
  cwd: z.string().max(1000).optional().describe('The folder the agent works in. A hint for which brain fits.'),
  budget: z.number().int().min(1000).max(40000).optional().describe('Most characters to return. Default 6000.'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe('Levels to read: 1 me card, 2 + brain index, 3 + matching claims, 4 + your chats. Default 4, which skips chats when claims already answer.'),
});

export function registerContextTool(server: ToolRegistrar): void {
  server.registerTool(
    'context',
    {
      title: 'Context for a question',
      description:
        'Call this first, with the user\'s question, before answering anything about a project, client, person or past decision. ' +
        'Returns, within a budget: your own me card, the matching brain\'s index page, the claims that match, and your own chats in that brain. Every line is dated. ' +
        'The newest dated fact wins; if something newer turns up elsewhere, record it with remember.',
      inputSchema: contextInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handling(async (args, mcp) => {
      const result = await buildContext(workosUserId(mcp.http?.authInfo), args);
      const { text, ...structured } = result;
      return textResult(text, { ...structured, text });
    }),
  );
}
