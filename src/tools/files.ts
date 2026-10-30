/**
 * Three file tools: list_files, get_file, add_file. Registered only when R2 is
 * configured.
 *
 * Every call resolves its brain through requireBrain first, so a caller only
 * ever touches files of brains they can read on GitHub. add_file goes further
 * and needs push access, because it lands at once rather than as a pull request.
 * There is deliberately no overwrite and no delete tool.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { requireBrain, requireBrainWriter } from '../auth/access.js';
import { workosUserId } from '../auth/workos.js';
import { FileRefused } from '../files/paths.js';
import { INLINE_UPLOAD_MAX_BYTES, type BrainFiles } from '../files/store.js';
import { brainArg, handling, textResult } from './shared.js';
import type { BrainRow } from '../types.js';

/** How a call proves who may read or write a brain. Injected so tests need no database. */
export interface FileAccess {
  read: (workosUserId: string, brain?: string) => Promise<BrainRow>;
  write: (workosUserId: string, brain?: string) => Promise<BrainRow>;
}

const defaultAccess: FileAccess = { read: requireBrain, write: requireBrainWriter };

const pathArg = z
  .string()
  .min(1)
  .max(1000)
  .describe('Path inside the brain\'s file space, e.g. "inputs/2026-09-01-report.xlsx". No leading slash, no "..".');

export const listFilesInput = z.object({
  brain: brainArg,
  folder: z.string().optional().describe('Only list under this folder, e.g. "inputs/".'),
  limit: z.number().int().min(1).max(1000).default(100),
  cursor: z.string().optional().describe('next_cursor from the previous page.'),
});

export const getFileInput = z.object({ brain: brainArg, path: pathArg });

export const addFileInput = z.object({
  brain: brainArg,
  path: pathArg,
  content: z
    .string()
    .optional()
    .describe(
      'The file as base64, up to about 10 MB. Omit it to get a presigned upload URL instead, for bigger files.',
    ),
});

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(content: string): Buffer {
  const compact = content.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !BASE64.test(compact)) {
    throw new FileRefused('content must be base64. Omit it to get an upload URL instead.');
  }
  // Checked before decoding so an oversized body is refused without allocating it.
  if ((compact.length / 4) * 3 > INLINE_UPLOAD_MAX_BYTES + 2) {
    throw new FileRefused(
      `content is over ${INLINE_UPLOAD_MAX_BYTES} bytes. Call add_file without content to get an upload URL.`,
    );
  }
  return Buffer.from(compact, 'base64');
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** The tool bodies, as plain functions of (args, caller). */
export function fileToolHandlers(files: BrainFiles, access: FileAccess = defaultAccess) {
  return {
    async list_files(args: z.infer<typeof listFilesInput>, caller: string) {
      const brain = await access.read(caller, args.brain);
      const listing = await files.list(brain.id, {
        folder: args.folder,
        cursor: args.cursor,
        limit: args.limit,
      });
      const header = `${listing.files.length} file${listing.files.length === 1 ? '' : 's'} in ${brain.id}${
        args.folder ? ` under ${args.folder}` : ''
      }`;
      const body = listing.files.length
        ? listing.files.map((f) => `- ${f.path} (${kb(f.size)}, ${f.last_modified ?? 'unknown date'})`).join('\n')
        : 'No files.';
      const more = listing.next_cursor ? `\n\nMore: pass cursor "${listing.next_cursor}".` : '';
      return textResult(`${header}\n\n${body}${more}`, { brain: brain.id, ...listing });
    },

    async get_file(args: z.infer<typeof getFileInput>, caller: string) {
      const brain = await access.read(caller, args.brain);
      const result = await files.get(brain.id, args.path);
      const lines = [
        `${result.file.path} in ${brain.id}: ${kb(result.file.size)}, ${result.file.content_type ?? 'unknown type'}, ` +
          `last modified ${result.file.last_modified ?? 'unknown'}.`,
        `Download (expires in ${Math.round(result.expires_in_seconds / 60)} minutes): ${result.download_url}`,
      ];
      if (result.text !== undefined) lines.push('', 'Content:', result.text);
      return textResult(lines.join('\n'), { brain: brain.id, ...result });
    },

    async add_file(args: z.infer<typeof addFileInput>, caller: string) {
      const brain = await access.write(caller, args.brain);
      const content = args.content === undefined ? undefined : decodeBase64(args.content);
      const result = await files.add(brain.id, args.path, content);
      if (result.status === 'stored') {
        return textResult(
          `Added ${result.file.path} to ${brain.id} (${kb(result.file.size)}). Files are add-only: it cannot be overwritten or deleted.`,
          { brain: brain.id, ...result },
        );
      }
      return textResult(
        [
          `Upload ${result.path} to ${brain.id} with an HTTP PUT of the raw bytes to this URL, sending exactly these headers: ` +
            Object.entries(result.required_headers)
              .map(([name, value]) => `${name}: ${value}`)
              .join(', ') +
            '.',
          `It expires in ${Math.round(result.expires_in_seconds / 60)} minutes.`,
          result.upload_url,
        ].join('\n'),
        { brain: brain.id, ...result },
      );
    },
  };
}

export function registerFileTools(server: McpServer, files: BrainFiles, access: FileAccess = defaultAccess): void {
  const handlers = fileToolHandlers(files, access);

  server.registerTool(
    'list_files',
    {
      title: 'List a brain\'s files',
      description:
        'List the private files stored with a brain (inputs, exports, attachments that are not markdown). Returns path, size and last modified, a page at a time.',
      inputSchema: listFilesInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handling(async (args, mcp) => handlers.list_files(args, workosUserId(mcp.http?.authInfo))),
  );

  server.registerTool(
    'get_file',
    {
      title: 'Get a brain file',
      description:
        'Metadata and a download link (valid about 15 minutes) for one file. Small csv, md, txt and json files also come back as text.',
      inputSchema: getFileInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handling(async (args, mcp) => handlers.get_file(args, workosUserId(mcp.http?.authInfo))),
  );

  server.registerTool(
    'add_file',
    {
      title: 'Add a file to a brain',
      description:
        'Store a new private file with a brain. Pass base64 content up to about 10 MB, or omit it to get a presigned upload URL. ' +
        'Add-only: refuses a path that already exists, and there is no overwrite or delete. Needs push access to the brain repo. ' +
        'This is not a git write and opens no pull request.',
      inputSchema: addFileInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handling(async (args, mcp) => handlers.add_file(args, workosUserId(mcp.http?.authInfo))),
  );
}
