import { McpServer } from '@modelcontextprotocol/server';
import { brainFilesFromEnv } from '../files/index.js';
import { registerBrainTools } from './brains.js';
import { registerFileTools } from './files.js';
import { registerReadTools } from './read.js';
import { registerWriteTools } from './write.js';

export interface ToolContext {
  version: string;
}

/**
 * The operating guide a client hands its model. Written for an agent that has
 * only this server and no house rules, so it says when to act, not just what
 * exists. Composio drops it, which is why every tool description repeats its
 * own trigger. The file lines appear only when the file tools are registered.
 */
export function serverInstructions(withFiles: boolean): string {
  const lines = [
    withFiles
      ? 'A brain is project memory: the decisions, context, people and status of one project or client, as markdown in a git repo, plus private files such as spreadsheets and PDFs.'
      : 'A brain is project memory: the decisions, context, people and status of one project or client, as markdown in a git repo.',
    'There is one brain per project or client, with an id like owner/repo; list_brains shows yours.',
    '',
    'Use it without being asked:',
    '- Before answering anything about a project, client, person, past decision or "what did we decide", search the matching brain (list_brains first if you lack its id). Cite each claim you use by its page, and its date when it has one.',
  ];
  if (withFiles) {
    lines.push(
      '- When the user mentions or needs a client file (spreadsheet, PDF, report), check list_files and get_file before asking for it.',
      '- When the user shares a client file worth keeping, or you produce one, store it with add_file without asking, named date first (YYYY-MM-DD-name.ext) in a sensible folder such as inputs/.',
    );
  }
  lines.push(
    '- When a durable decision or fact is settled in the conversation, propose it with remember. Tell the user it opens a pull request on the brain repo and nothing changes until a person merges it. Use update_fact or forget for an outdated claim.',
    '',
    'Pick the brain by the project or client the user names. If several match, say which one you used.',
    '',
    'Claims carry a page, plus an authority and verification date when set. Say when a claim is old, undated or superseded.',
  );
  if (withFiles) lines.push('Files are add-only: an existing path is refused and nothing is ever deleted.');
  return lines.join('\n');
}

/**
 * Six claim tools: search, get_claim, explain_claim, remember, update_fact,
 * forget. Read and write both. The pull-request gate is what makes writing safe.
 *
 * Plus three file tools (list_files, get_file, add_file) when R2 is configured.
 * File adds are not git writes: they are add-only instead of reviewed.
 *
 * Plus list_brains. Which brains a caller can reach is context, so it is also
 * the brain://mine resource, but Composio and many clients expose only tools,
 * and an agent that cannot see the list has to guess ids.
 *
 * A fresh server per request. Nothing about a caller's brain or identity is held
 * on the instance, so one request can never see another tenant's scope.
 */
export function buildServer(ctx: ToolContext): McpServer {
  const files = brainFilesFromEnv();
  const server = new McpServer(
    { name: 'brain-mcp', version: ctx.version, title: 'Remote second brain' },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: serverInstructions(files !== null),
    },
  );

  registerBrainTools(server);
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  if (files) registerFileTools(server, files);

  return server;
}
