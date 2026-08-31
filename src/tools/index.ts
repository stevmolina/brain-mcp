import { McpServer } from '@modelcontextprotocol/server';
import { accessibleBrains } from '../auth/access.js';
import { workosUserId } from '../auth/workos.js';
import { registerReadTools } from './read.js';
import { registerWriteTools } from './write.js';

export interface ToolContext {
  version: string;
}

/**
 * Six tools: search, get_claim, explain_claim, remember, update_fact, forget.
 * Read and write both. The pull-request gate is what makes writing safe.
 *
 * A fresh server per request. Nothing about a caller's brain or identity is held
 * on the instance, so one request can never see another tenant's scope.
 */
export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'brain-mcp', version: ctx.version, title: 'Remote second brain' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions:
        'Each brain is a git repository of markdown; the repository is canonical and this index is a rebuildable copy. ' +
        'Search and read claims here. Every claim carries its page, line, authority and verification date: quote those when you use one. ' +
        'A claim with no authority is durable and is never chased. ' +
        'Writes open a pull request against the brain repository and change nothing until a human merges it.',
    },
  );

  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);

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

  return server;
}
