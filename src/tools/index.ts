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
 * Six tools: search, get_claim, explain_claim, remember, update_fact, forget.
 * Read and write both. The pull-request gate is what makes writing safe.
 *
 * Plus three file tools (list_files, get_file, add_file) when R2 is configured.
 * File adds are not git writes: they are add-only instead of reviewed.
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

  const files = brainFilesFromEnv();
  if (files) registerFileTools(server, files);

  registerBrainTools(server);

  return server;
}
