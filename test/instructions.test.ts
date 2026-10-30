/**
 * The server instructions are the only guide an agent gets when it has this
 * server and no house rules. They stay short, name every tool they ask the agent
 * to use, and never mention file tools the server did not register.
 */
import { describe, expect, it } from 'vitest';
import { serverInstructions } from '../src/tools/index.js';

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

describe('server instructions', () => {
  it('stay under 250 words with the file tools on', () => {
    expect(words(serverInstructions(true))).toBeLessThan(250);
  });

  it('tell the agent when to use each tool', () => {
    const text = serverInstructions(true);
    for (const tool of ['list_brains', 'search', 'list_files', 'get_file', 'add_file', 'remember', 'update_fact', 'forget']) {
      expect(text).toContain(tool);
    }
    expect(text).toMatch(/without being asked/);
    expect(text).toMatch(/pull request/);
  });

  it('leave out the file tools when R2 is not configured', () => {
    const text = serverInstructions(false);
    expect(text).toContain('search');
    for (const tool of ['list_files', 'get_file', 'add_file']) expect(text).not.toContain(tool);
  });
});
