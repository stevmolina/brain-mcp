/**
 * Chat search with the index: cleaning, keywords, meaning, fusion, isolation.
 *
 * Invented people and chats only. A fake embedder stands in for the model: it
 * maps a few words in two languages onto shared concepts, so a Spanish
 * question can land on an English chat without downloading anything.
 */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.SESSIONS_DATABASE_URL ||= process.env.DATABASE_URL;

const { closeSessionsDb, migrateSessions, sessionsDb } = await import('../src/sessions/db.js');
const { setEmbedder } = await import('../src/sessions/embed.js');
const { cleanTurn, stripInjected, BoilerplateCounter, splitIdentifiers } = await import('../src/sessions/clean.js');
const { syncSessionIndex, prepareChat, forgetIndexSchema } = await import('../src/sessions/search-index.js');
const { rankChats, questionWords } = await import('../src/sessions/rank.js');
const store = await import('../src/sessions/store.js');
import type { Embedder } from '../src/sessions/embed.js';

const ALICE = 'user_search_test_alice';
const BOB = 'user_search_test_bob';
const SRC = 'searchtest';

// Concepts shared by both languages; any other word hashes to its own slot.
const CONCEPTS: Record<string, number> = {
  profile: 0, perfil: 0, profiles: 0, perfiles: 0,
  memory: 1, ram: 1, memoria: 1,
  invoice: 2, factura: 2, invoices: 2, facturas: 2,
};
const fake: Embedder = {
  model: 'fake-test-embedder',
  async embed(texts) {
    return texts.map((text) => {
      const v = new Array(32).fill(0);
      for (const word of text.toLowerCase().split(/[^a-z0-9áéíóúñ]+/).filter(Boolean)) {
        const slot = CONCEPTS[word] ?? 3 + ([...word].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 29);
        v[slot] += CONCEPTS[word] !== undefined ? 3 : 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  },
};

// Long pasted instructions, the same in every chat, like an agent app sends.
const PASTED = Array.from({ length: 40 }, (_, i) => `Rule ${i}: always answer about kettles and lighthouse maintenance schedules carefully.`).join('\n');
const pokebotsTurn = (message: string) =>
  `<user_query> <openbot-developer-instructions>${PASTED}</openbot-developer-instructions>
<openbot_saved_memories>The person likes kettles. Lighthouse notes.</openbot_saved_memories>
--- recent messages ---
user: something about kettles from another chat
--- current message ---
${message} </user_query>`;

function turns(...pairs: Array<[string, string]>) {
  return JSON.stringify(pairs.map(([role, text]) => ({ role, text })));
}

async function seed(id: string, owner: string, brain: string, title: string, card: string | null, t: string) {
  await sessionsDb().query(
    `insert into sessions (source, id, machine, provider, cwd, title, started_at, updated_at, body, turns, owner, brain, card, card_updated_at, clean_fingerprint)
     values ($1, $2, 'test-box', 'grok', '/work', $3, now() - interval '2 days', now() - interval '1 day', $4, $5::jsonb, $6, $7, $8, now(), md5($4))`,
    [SRC, id, title, JSON.parse(t).map((x: { text: string }) => x.text).join('\n'), t, owner, brain, card],
  );
}

async function cleanup() {
  await sessionsDb().query('delete from sessions where source = $1', [SRC]);
  for (const table of ['session_docs', 'session_postings', 'session_boilerplate']) {
    await sessionsDb().query(`delete from brain_mcp.${table} where owner = any($1)`, [[ALICE, BOB]]).catch(() => {});
  }
  await sessionsDb().query(`delete from brain_mcp.session_chunks where source = $1`, [SRC]).catch(() => {});
}

const ids = (hits: Array<{ id: string }>) => hits.map((h) => h.id);

beforeAll(async () => {
  await sessionsDb().query('create extension if not exists vector');
  await sessionsDb().query(await readFile(new URL('./fixtures/sessions-table.sql', import.meta.url), 'utf8'));
  await sessionsDb().query('alter table sessions add column if not exists card text, add column if not exists card_updated_at timestamptz');
  await migrateSessions();
  forgetIndexSchema();
  await cleanup();
  store.resetSessionColumnsCache();

  // Alice's chats. Every one carries the same pasted instructions about
  // kettles and lighthouses; only the real messages differ.
  await seed('a-site', ALICE, 'test-org/alpha', 'Hi. I want to create a profile on zentrovia.', null,
    turns(['user', pokebotsTurn('Hi. I want to create a profile on zentrovia. Do I already have one?')], ['assistant', 'You do not have a zentrovia profile yet. Make one.']));
  await seed('a-ram', ALICE, 'test-org/alpha', 'Server check', null,
    turns(['user', pokebotsTurn('How much RAM is the box using?')], ['assistant', 'Memory use is 3.1 GB of 8.']));
  await seed('a-invoice', ALICE, 'test-org/beta', 'Billing run', null,
    turns(['user', pokebotsTurn('Send the October invoices to the pelican client.')], ['assistant', 'Invoices sent.']));
  for (let i = 0; i < 4; i++) {
    await seed(`a-noise-${i}`, ALICE, 'test-org/alpha', `Kettle chat ${i}`, null,
      turns(['user', pokebotsTurn(`Tell me a joke number ${i}.`)], ['assistant', 'Here is a joke.']));
  }
  // Bob has a chat on the same rare word. Alice must never get it.
  await seed('b-site', BOB, 'test-org/alpha', 'Bob zentrovia profile', null,
    turns(['user', 'My zentrovia profile is bob.'], ['assistant', 'Noted.']));
});

afterAll(async () => {
  setEmbedder(undefined);
  await cleanup();
  await closeSessionsDb();
});

describe('cleaning pasted text', () => {
  it('keeps only the current message of an agent-app turn', () => {
    const clean = cleanTurn(pokebotsTurn('Is the zentrovia profile mine?'));
    expect(clean).toBe('Is the zentrovia profile mine?');
  });

  it('removes tagged blocks, unwraps the person\'s own words, drops lone tags', () => {
    const text = '<system-reminder>do this</system-reminder>\n<user_query>fix the <b>deploy</b></user_query>\n<stray>';
    expect(cleanTurn(text)).toBe('fix the');
    expect(stripInjected('plain words stay')).toContain('plain words stay');
  });

  it('drops lines pasted into many chats', () => {
    const counter = new BoilerplateCounter();
    for (let i = 0; i < 5; i++) counter.addChat([`# Machine rules for every agent here\nquestion number ${i} about walruses`]);
    const boiler = counter.result();
    expect(cleanTurn('# Machine rules for every agent here\nwhere is the walrus feed?', boiler)).toBe('where is the walrus feed?');
  });

  it('reads dotted names as their parts', () => {
    expect(splitIdentifiers('see zentrovia.io and src/auth/access.ts')).toBe('see zentrovia io and src auth access ts');
  });

  it('builds a title-and-card passage plus one per message', () => {
    const chat = prepareChat({
      source: 's', id: 'i', owner: 'o', brain: null, title: 'T', card: 'Where: x\nAsked: y',
      turns: [{ role: 'user', text: 'first real question here' }, { role: 'assistant', text: 'answer' }],
    });
    expect(chat.chunks[0]).toBe('T\nAsked: y');
    expect(chat.chunks[1]).toBe('first real question here\nanswer');
  });

  it('drops question filler in both languages', () => {
    expect(questionWords('chequea zentrovia capo tengo algun perfil ahi?')).toBe('zentrovia perfil');
    expect(questionWords('hey can you check the zentrovia profile')).toBe('the zentrovia profile');
  });
});

describe('ranking with the index', () => {
  beforeAll(async () => {
    setEmbedder(fake, { ready: true });
    const result = await syncSessionIndex(sessionsDb(), { owner: ALICE, embedder: fake, rebuild: true });
    expect(result.indexed).toBe(7);
    await syncSessionIndex(sessionsDb(), { owner: BOB, embedder: fake, rebuild: true });
  });

  it('finds the rare word in Spanish filler, above chats that share only pasted text', async () => {
    const hits = await rankChats(sessionsDb(), { ownerId: ALICE, question: 'chequea zentrovia capo tengo algun perfil ahi?', limit: 5, embedder: fake });
    expect(ids(hits)[0]).toBe('a-site');
    expect(ids(hits)).not.toContain('b-site');
  });

  it('pasted words find nothing: they were cleaned out of every chat', async () => {
    const hits = await rankChats(sessionsDb(), {
      ownerId: ALICE, question: 'lighthouse maintenance schedules', limit: 5, embedder: null,
    });
    expect(hits).toEqual([]);
  });

  it('meaning search crosses languages', async () => {
    const hits = await rankChats(sessionsDb(), { ownerId: ALICE, question: 'cuanta memoria usa?', limit: 3, embedder: fake, params: { minMeaning: 0.5 } });
    expect(ids(hits)[0]).toBe('a-ram');
    expect(hits[0]!.meaning).not.toBeNull();
  });

  it('filters by brain and never returns another owner\'s chat', async () => {
    const beta = await rankChats(sessionsDb(), { ownerId: ALICE, question: 'invoices pelican', limit: 5, brains: ['test-org/beta'], embedder: fake });
    expect(ids(beta)).toEqual(['a-invoice']);
    const asBob = await rankChats(sessionsDb(), { ownerId: BOB, question: 'zentrovia profile', limit: 10, embedder: fake });
    expect(ids(asBob)).toEqual(['b-site']);
  });

  it('context and search_sessions use it once the index holds the caller\'s chats', async () => {
    const forContext = await store.sessionsForQuestion(ALICE, ['test-org/alpha', 'test-org/beta'], 'tengo perfil en zentrovia?', 5);
    expect(forContext[0]!.id).toBe('a-site');
    expect(['keyword', 'both']).toContain(forContext[0]!.match);
    const listed = await store.searchSessions(ALICE, { query: 'zentrovia', tool: 'grok' });
    expect(ids(listed)).toEqual(['a-site']);
    const otherTool = await store.searchSessions(ALICE, { query: 'zentrovia', tool: 'codex' });
    expect(otherTool).toEqual([]);
  });

  it('a changed chat is re-indexed and a deleted one leaves the index', async () => {
    await sessionsDb().query(
      `update sessions set title = 'Quokka census', clean_fingerprint = 'changed' where source = $1 and id = 'a-noise-0'`,
      [SRC],
    );
    await sessionsDb().query(`delete from sessions where source = $1 and id = 'a-noise-1'`, [SRC]);
    const result = await syncSessionIndex(sessionsDb(), { owner: ALICE, embedder: fake });
    expect(result.indexed).toBe(1);
    expect(result.removed).toBe(1);
    const hits = await rankChats(sessionsDb(), { ownerId: ALICE, question: 'quokka', limit: 5, embedder: null });
    expect(ids(hits)).toEqual(['a-noise-0']);
  });
});
