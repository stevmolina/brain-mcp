/**
 * Which brains the caller can reach, as a tool and as a resource.
 *
 * Both read the same list from accessibleBrains, so GitHub stays the only
 * permission list and the two can never disagree. The tool exists because
 * Composio and many MCP clients expose only tools: an agent there never sees a
 * resource, and without this it would have to guess brain ids.
 *
 * Push access is left out on purpose. It costs one more GitHub call per brain,
 * and add_file already says so when it is refused.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { accessibleBrains } from '../auth/access.js';
import { workosUserId } from '../auth/workos.js';
import { isoDay } from '../dates.js';
import { handling, textResult } from './shared.js';
import type { BrainRow } from '../types.js';

export interface BrainSummary {
  id: string;
  repo: string;
  default_branch: string;
  last_indexed_commit: string | null;
  last_indexed_at: string | null;
}

export function brainSummary(brain: BrainRow): BrainSummary {
  return {
    id: brain.id,
    repo: `${brain.repo_owner}/${brain.repo_name}`,
    default_branch: brain.default_branch,
    last_indexed_commit: brain.last_indexed_commit,
    last_indexed_at: isoDay(brain.last_indexed_at),
  };
}

/** The list_brains result for one caller. Exported so tests can call it without a transport. */
export async function listBrains(workosUserId: string) {
  const brains = (await accessibleBrains(workosUserId)).map(brainSummary);
  if (brains.length === 0) {
    return textResult(
      'You have no brains yet. Install the GitHub App on a markdown repo and register it as a brain.',
      { brains },
    );
  }
  const lines = brains.map(
    (b) => `- ${b.id}${b.repo === b.id ? '' : ` (repo ${b.repo})`}${b.last_indexed_at ? ` (indexed ${b.last_indexed_at})` : ' (not indexed yet)'}`,
  );
  return textResult(
    [`Brains you can reach (${brains.length}). Pass the id as \`brain\` to the other tools.`, ...lines].join('\n'),
    { brains },
  );
}

export function registerBrainTools(server: McpServer): void {
  server.registerTool(
    'list_brains',
    {
      title: 'List your brains',
      description:
        'List the project brains you can reach and their ids (owner/repo). ' +
        'Call it first when a question touches a project, client, person or past decision and you do not know which brain holds it, then search that brain.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handling(async (_args, mcp) => listBrains(workosUserId(mcp.http?.authInfo))),
  );

  server.registerResource(
    'brains',
    'brain://mine',
    {
      title: 'Your brains',
      description: 'Brains this account may read, as answered by GitHub repository access. Same list as the list_brains tool.',
      mimeType: 'application/json',
    },
    async (uri, mcp) => {
      const brains = (await accessibleBrains(workosUserId(mcp.http?.authInfo))).map(brainSummary);
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(brains, null, 2) }],
      };
    },
  );
}
