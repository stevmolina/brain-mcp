import { McpServer } from '@modelcontextprotocol/server';
import { accessibleBrains } from '../auth/access.js';
import { workosUserId } from '../auth/workos.js';
import { MODE_HELP, resolveWriteModes } from '../writes/modes.js';
import { registerOnboardingTools } from './onboarding.js';
import { registerReadTools } from './read.js';
import { registerSettingsTools } from './settings.js';
import { registerWriteTools } from './write.js';

export interface ToolContext {
  version: string;
}

/**
 * Read tools, write tools, write-mode settings, and onboarding.
 *
 * A fresh server per request. Nothing about a caller's brain or identity is held
 * on the instance, so one request can never see another tenant's scope.
 */
export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'brain-mcp', version: ctx.version, title: 'Agent Brain' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'Each brain is a git repository of markdown. The repository is canonical and this index is a rebuildable copy. ' +
        'Search and read claims here. Every claim carries its page, line, authority and verification date: quote those when you use one. ' +
        'A claim with no authority is durable and is never chased. ' +
        'Writes follow the brain mode for that action. review (the default) opens a pull request. auto commits to the default branch and is searchable immediately. read_only refuses. ' +
        'Use get_write_modes and set_write_mode to see or change modes. Only the brain owner can change them. ' +
        'A caller with no brain yet should use list_connectable_repos, connect_brain, or create_brain.',
    },
  );

  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  registerSettingsTools(server, ctx);
  registerOnboardingTools(server, ctx);

  // Which brains the caller can reach is context, not an action, so it is a
  // resource rather than a seventh tool.
  server.registerResource(
    'brains',
    'brain://mine',
    {
      title: 'Your brains',
      description: 'Brains this account may read, as answered by GitHub repository access.',
      mimeType: 'application/json',
    },
    async (uri, mcp) => {
      const brains = await accessibleBrains(workosUserId(mcp.http?.authInfo));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              brains.map((brain) => ({
                id: brain.id,
                repo: `${brain.repo_owner}/${brain.repo_name}`,
                default_branch: brain.default_branch,
                write_modes: resolveWriteModes(brain.write_modes),
                last_indexed_commit: brain.last_indexed_commit,
                last_indexed_at: brain.last_indexed_at,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerResource(
    'settings',
    'brain://settings',
    {
      title: 'Write modes',
      description: 'How remember, update_fact, and forget behave on each brain you can read. The owner changes them with set_write_mode.',
      mimeType: 'application/json',
    },
    async (uri, mcp) => {
      const userId = workosUserId(mcp.http?.authInfo);
      const brains = await accessibleBrains(userId);
      const body =
        brains.length === 0
          ? {
              brains: [],
              hint: 'You have no brain yet. Use list_connectable_repos, connect_brain, or create_brain.',
            }
          : {
              brains: brains.map((brain) => ({
                id: brain.id,
                write_modes: resolveWriteModes(brain.write_modes),
                owner_can_edit: brain.owner_workos_user_id === userId,
              })),
              modes: MODE_HELP,
            };
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }],
      };
    },
  );

  return server;
}
