/**
 * The first commit in a brain created from here. Prose only, except one durable
 * claim on the default write page, so the new brain is searchable immediately.
 * sources/ is evidence and stays free of claims.
 */

export interface SeedFile {
  path: string;
  content: string;
}

export const STARTER_COMMIT_MESSAGE = 'brain: start the brain with a claims page and a sources directory';

const README = `# Agent Brain

This repository is a brain. Claims are markdown bullets, usually in wiki/index.md. The git history is the record. A search index is rebuilt from that history.

Files under sources/ are received evidence. They are indexed and never written by the server.
`;

const WIKI = `# Index

## Claims

- This brain stores claims as markdown bullets in git.
`;

const SOURCES = `# Sources

Put received evidence here (notes, exports, files you were given). The server indexes this directory and never writes to it.
`;

export function starterFiles(): SeedFile[] {
  return [
    { path: 'README.md', content: README },
    { path: 'wiki/index.md', content: WIKI },
    { path: 'sources/README.md', content: SOURCES },
  ];
}
