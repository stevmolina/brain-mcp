/**
 * First-run tools. These do not call requireBrain: the caller has no brain yet.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { workosUserId } from '../auth/workos.js';
import { connectBrain, listConnectableRepos, startCreateBrain } from '../onboarding/flow.js';
import { createOnboardingHost } from '../onboarding/github.js';
import type { OnboardingReply } from '../onboarding/types.js';
import { errorResult, handling, textResult } from './shared.js';
import type { ToolContext } from './index.js';

function reply(result: OnboardingReply) {
  return result.isError ? errorResult(result.text) : textResult(result.text, result.structured);
}

export function registerOnboardingTools(server: McpServer, ctx: ToolContext): void {
  const host = () => createOnboardingHost();

  server.registerTool(
    'list_connectable_repos',
    {
      title: 'List repos you can connect',
      description:
        'List repositories on your GitHub account that the GitHub App can see, and which of them are already brains. Use this when you have no brain yet, or when you want to connect another repo. Organization repos that the app is installed on can be connected with connect_brain even if they are not in this list.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handling(async (_args, mcp) => reply(await listConnectableRepos(workosUserId(mcp.http?.authInfo), host()))),
  );

  server.registerTool(
    'connect_brain',
    {
      title: 'Connect an existing repository',
      description:
        'Register a GitHub repository you can access as a brain and index it. The GitHub App must already be installed on that repository. Pass repo as owner/name.',
      inputSchema: z.object({
        repo: z.string().min(3).describe('Repository to connect, as owner/name.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    handling(async (args, mcp) => reply(await connectBrain(workosUserId(mcp.http?.authInfo), args.repo, host()))),
  );

  server.registerTool(
    'create_brain',
    {
      title: 'Create a private brain repository',
      description:
        'Create a private GitHub repository on your account, with a starter claims page, and connect it as a brain. Requires the GitHub App installed on your account. If one-step creation is not configured, the reply tells you how to create the repo yourself and connect it.',
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe('Repository name. Defaults to agent-brain. Always created private, on your user account.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    handling(async (args, mcp) =>
      reply(await startCreateBrain(workosUserId(mcp.http?.authInfo), args.name, host())),
    ),
  );

  void ctx;
}
