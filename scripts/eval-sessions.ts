/**
 * Scores chat search against labeled questions: recall@5 and MRR@10.
 *
 * The questions are real, so they live in the sessions database
 * (brain_mcp.search_eval_cases), never in this public repo. This script prints
 * aggregate numbers only, unless --verbose, so CI logs show no chat text.
 *
 *   doppler run -- pnpm eval:sessions --load cases.json --owner <workos id>
 *   doppler run -- pnpm eval:sessions [--schema brain_mcp_eval] [--build] [--rebuild]
 *        [--systems legacy,keyword,meaning,hybrid] [--check eval/sessions-baseline.json]
 *        [--verbose] [--dump dir] [--grid]
 *
 * --build syncs the index into --schema first (a scratch schema keeps the live
 * one untouched; vectors come from the shared cache, so only new text is
 * embedded). --check fails (exit 1) when a system scores below the recorded
 * floor in that file.
 *
 * Metrics, per case with at least one relevant chat, after dropping the
 * case's `exclude` chats from the ranked list:
 *   recall@5  share of the relevant chats in the first 5
 *   MRR@10    1 / rank of the first relevant chat in the first 10, else 0
 * Negative cases (nothing relevant) report how often nothing came back.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { closeSessionsDb, migrateSessions, sessionsDb } from '../src/sessions/db.js';
import { getEmbedder } from '../src/sessions/embed.js';
import { DEFAULT_RANK, rankChats, type RankParams } from '../src/sessions/rank.js';
import { syncSessionIndex } from '../src/sessions/search-index.js';
import { legacySessionsForQuestion } from '../src/sessions/store.js';

interface Case {
  owner: string;
  id: string;
  query: string;
  lang: string | null;
  kinds: string[];
  relevant: Record<string, number>;
  exclude: string[];
}

const { values } = parseArgs({
  options: {
    load: { type: 'string' },
    owner: { type: 'string' },
    schema: { type: 'string', default: 'brain_mcp' },
    build: { type: 'boolean', default: false },
    rebuild: { type: 'boolean', default: false },
    // Build the index from raw turns (no cleaning), to measure cleaning alone.
    raw: { type: 'boolean', default: false },
    systems: { type: 'string', default: 'legacy,keyword,meaning,hybrid' },
    check: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    dump: { type: 'string' },
    grid: { type: 'boolean', default: false },
    // A JSON file with a list of parameter sets to score instead of the built-in grid.
    'grid-json': { type: 'string' },
    params: { type: 'string' },
    // Score only chats started before the cases were written, so new chats
    // do not move the numbers. --no-frozen scores against everything.
    frozen: { type: 'boolean', default: true },
    'prune-ci': { type: 'string' },
  },
  allowNegative: true,
});

const db = sessionsDb();

async function loadCases(file: string, owner: string): Promise<void> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as Array<{
    id: string; query: string; lang?: string; kind?: string[]; relevant?: Record<string, number>; exclude?: string[]; note?: string;
  }>;
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query('delete from brain_mcp.search_eval_cases where owner = $1', [owner]);
    for (const c of raw) {
      await client.query(
        `insert into brain_mcp.search_eval_cases (owner, id, query, lang, kinds, relevant, exclude, note)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [owner, c.id, c.query, c.lang ?? null, c.kind ?? [], JSON.stringify(c.relevant ?? {}), c.exclude ?? [], c.note ?? null],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  console.log(`loaded ${raw.length} cases for one owner`);
}

type Ranker = (c: Case) => Promise<string[]>;

interface Score {
  system: string;
  cases: number;
  recall5: number;
  mrr10: number;
  hit5: number;
  negatives: number;
  negativesEmpty: number;
  p50ms: number;
  p95ms: number;
  byKind: Record<string, { n: number; recall5: number; mrr10: number }>;
}

async function score(system: string, cases: Case[], rank: Ranker, runs?: Record<string, Record<string, number>>): Promise<Score> {
  let recall = 0;
  let mrr = 0;
  let hit = 0;
  let positives = 0;
  let negatives = 0;
  let negEmpty = 0;
  const times: number[] = [];
  const byKind: Score['byKind'] = {};
  for (const c of cases) {
    const started = performance.now();
    // One retry: a query lost on a flaky network times out instead of hanging.
    const ranked = (await rank(c).catch(() => rank(c))).filter((key) => !c.exclude.includes(key));
    times.push(performance.now() - started);
    if (runs) runs[c.id] = Object.fromEntries(ranked.slice(0, 10).map((key, i) => [key, 10 - i]));
    const rel = Object.entries(c.relevant).filter(([, g]) => g > 0).map(([k]) => k);
    if (!rel.length) {
      negatives += 1;
      if (!ranked.length) negEmpty += 1;
      if (values.verbose) console.log(`  [neg] ${c.id} returned ${ranked.length}`);
      continue;
    }
    positives += 1;
    const top5 = ranked.slice(0, 5);
    const r = rel.filter((k) => top5.includes(k)).length / rel.length;
    const first = ranked.slice(0, 10).findIndex((k) => rel.includes(k));
    const m = first >= 0 ? 1 / (first + 1) : 0;
    recall += r;
    mrr += m;
    if (r > 0) hit += 1;
    for (const kind of c.kinds.length ? c.kinds : ['other']) {
      const k = (byKind[kind] ??= { n: 0, recall5: 0, mrr10: 0 });
      k.n += 1;
      k.recall5 += r;
      k.mrr10 += m;
    }
    if (values.verbose && r < 1) {
      console.log(`  [miss] ${c.id} r@5=${r.toFixed(2)} rr=${m.toFixed(2)} q=${JSON.stringify(c.query)} got=${ranked.slice(0, 5).join(' ')}`);
    }
  }
  for (const k of Object.values(byKind)) {
    k.recall5 /= k.n;
    k.mrr10 /= k.n;
  }
  times.sort((a, b) => a - b);
  return {
    system,
    cases: positives,
    recall5: recall / Math.max(positives, 1),
    mrr10: mrr / Math.max(positives, 1),
    hit5: hit / Math.max(positives, 1),
    negatives,
    negativesEmpty: negEmpty,
    p50ms: times[Math.floor(times.length / 2)] ?? 0,
    p95ms: times[Math.floor(times.length * 0.95)] ?? 0,
    byKind,
  };
}

async function main(): Promise<void> {
  await migrateSessions();
  if (values.load) {
    if (!values.owner) throw new Error('--load needs --owner');
    await loadCases(values.load, values.owner);
    return;
  }

  const { rows: cases } = await db.query<Case & { created_at: Date }>(
    `select owner, id, query, lang, kinds, relevant, exclude, created_at from brain_mcp.search_eval_cases
      where ($1::text is null or owner = $1) order by owner, id`,
    [values.owner ?? null],
  );
  if (!cases.length) throw new Error('no eval cases in brain_mcp.search_eval_cases');
  const cutoff = values.frozen ? new Date(Math.min(...cases.map((c) => new Date(c.created_at).getTime()))) : null;
  const frozenFilter = cutoff ? { sql: 'coalesce(s.started_at, s.updated_at) < $1::timestamptz', args: [cutoff.toISOString()] } : undefined;
  if (!cases.length) throw new Error('no eval cases in brain_mcp.search_eval_cases');
  const owners = [...new Set(cases.map((c) => c.owner))];
  const schema = values.schema!;
  const embedder = getEmbedder();

  if (values.build || values.rebuild) {
    for (const owner of owners) {
      const started = Date.now();
      const r = await syncSessionIndex(db, {
        schema, owner, embedder: values.raw ? null : embedder, rebuild: values.rebuild, raw: values.raw,
        log: values.verbose ? (m) => console.log(m) : undefined,
      });
      console.log(`index ${schema}: ${r.indexed} chats indexed, ${r.embedded} passages embedded, ${r.removed} removed, ${Date.now() - started} ms`);
    }
  }

  // All brains of the owner: the eval asks across every chat, a harder
  // setting than `context`, which narrows to at most two brains.
  const brainsOf = new Map<string, string[]>();
  const frozenSet = new Set<string>();
  for (const owner of owners) {
    const { rows } = await db.query<{ brain: string }>(`select distinct brain from sessions where owner = $1 and brain is not null`, [owner]);
    brainsOf.set(owner, rows.map((r) => r.brain));
    if (cutoff) {
      const { rows: keep } = await db.query<{ key: string }>(
        `select source || ':' || id as key from sessions where owner = $1 and coalesce(started_at, updated_at) < $2`,
        [owner, cutoff],
      );
      for (const k of keep) frozenSet.add(k.key);
    }
  }
  const inFrozen = (key: string) => !cutoff || frozenSet.has(key);

  // Question vectors once per case, shared by every hybrid setting.
  const vectors = new Map<string, number[]>();
  const vectorOf = async (c: Case) => {
    if (!embedder) return null;
    const key = `${c.owner}:${c.id}`;
    let v = vectors.get(key);
    if (!v) {
      v = (await embedder.embed([c.query], 'query'))[0]!;
      vectors.set(key, v);
    }
    return v;
  };
  const extra: Partial<RankParams> = values.params ? JSON.parse(values.params) : {};
  const ranked = (params: Partial<RankParams>): Ranker => async (c) => {
    const vector = params.depthMeaning === 0 ? null : await vectorOf(c);
    const hits = await rankChats(db, {
      // Room for the case's excluded chats, so 10 remain after dropping them.
      ownerId: c.owner, question: c.query, limit: 10 + c.exclude.length, schema, embedder, vector, params: { ...extra, ...params },
      filter: frozenFilter,
    });
    return hits.map((h) => `${h.source}:${h.id}`);
  };
  const systems: Record<string, Ranker> = {
    legacy: async (c) =>
      (await legacySessionsForQuestion(c.owner, brainsOf.get(c.owner) ?? [], c.query, 30 + c.exclude.length))
        .map((s) => `${s.source}:${s.id}`)
        .filter(inFrozen)
        .slice(0, 10 + c.exclude.length),
    keyword: ranked({ depthMeaning: 0 }),
    meaning: ranked({ depthKeyword: 0 }),
    hybrid: ranked({}),
  };

  const wanted = values.systems!.split(',').map((s) => s.trim()).filter(Boolean);
  // Warm the model and the connection before timing anything.
  if (embedder && wanted.some((w) => w !== 'legacy' && w !== 'keyword')) await embedder.embed(['warm'], 'query');
  await db.query('select 1');

  const scores: Score[] = [];
  const runs: Record<string, Record<string, Record<string, number>>> = {};
  for (const name of wanted) {
    const rank = systems[name];
    if (!rank) throw new Error(`unknown system ${name}`);
    if (values.verbose) console.log(`-- ${name}`);
    runs[name] = {};
    scores.push(await score(name, cases, rank, runs[name]));
  }

  if (values.grid || values['grid-json']) {
    const grid: Array<Partial<RankParams>> = values['grid-json'] ? JSON.parse(await readFile(values['grid-json'], 'utf8')) : [];
    const zero = { minKeyword: 0, minMeaning: 0 };
    if (!values['grid-json']) for (const wAbout of [1, 3, 6]) for (const wUser of [1, 1.5, 3]) for (const wAgent of [0.3, 1]) grid.push({ ...zero, wAbout, wUser, wAgent, depthMeaning: 0 });
    if (!values['grid-json']) for (const wMeaning of [0.5, 0.75, 1, 1.5]) for (const rrfK of [10, 30, 60]) grid.push({ ...zero, wMeaning, rrfK });
    if (!values['grid-json']) for (const minKeyword of [0.2, 0.3, 0.4, 0.5, 0.6]) for (const minMeaning of [0.84, 0.86, 0.88, 0.9]) grid.push({ minKeyword, minMeaning });
    for (let i = 0; i < grid.length; i += 4) {
      const batch = await Promise.all(grid.slice(i, i + 4).map((params) => score(JSON.stringify(params), cases, ranked(params))));
      for (const s of batch) {
        console.log(`grid ${s.system} r@5=${s.recall5.toFixed(3)} mrr=${s.mrr10.toFixed(3)} negEmpty=${s.negativesEmpty}/${s.negatives}`);
      }
    }
  }

  const table = scores.map((s) => ({
    system: s.system,
    cases: s.cases,
    'recall@5': s.recall5.toFixed(3),
    'MRR@10': s.mrr10.toFixed(3),
    'hit@5': s.hit5.toFixed(3),
    'negatives empty': `${s.negativesEmpty}/${s.negatives}`,
    'p50 ms': Math.round(s.p50ms),
    'p95 ms': Math.round(s.p95ms),
  }));
  console.table(table);
  if (values.verbose) {
    for (const s of scores) {
      console.log(s.system, Object.entries(s.byKind).map(([k, v]) => `${k}(${v.n}) r@5=${v.recall5.toFixed(2)} mrr=${v.mrr10.toFixed(2)}`).join('  '));
    }
  }
  if (values.dump) {
    await mkdir(values.dump, { recursive: true });
    const qrels = Object.fromEntries(cases.map((c) => [c.id, Object.fromEntries(Object.entries(c.relevant).filter(([k]) => !c.exclude.includes(k)))]));
    await writeFile(`${values.dump}/qrels.json`, JSON.stringify(qrels));
    for (const [name, run] of Object.entries(runs)) await writeFile(`${values.dump}/run-${name}.json`, JSON.stringify(run));
    await writeFile(`${values.dump}/scores.json`, JSON.stringify(scores, null, 2));
  }

  if (values.check) {
    const floor = JSON.parse(await readFile(values.check, 'utf8')) as {
      systems: Record<string, { 'recall@5': number; 'MRR@10': number }>;
      tolerance?: number;
    };
    const tolerance = floor.tolerance ?? 0;
    let failed = false;
    for (const [system, min] of Object.entries(floor.systems)) {
      const got = scores.find((s) => s.system === system);
      if (!got) {
        console.error(`check: system ${system} was not run`);
        failed = true;
        continue;
      }
      for (const [metric, value] of [['recall@5', got.recall5], ['MRR@10', got.mrr10]] as const) {
        if (value + tolerance < min[metric]) {
          console.error(`check FAILED: ${system} ${metric} ${value.toFixed(3)} is below the recorded ${min[metric].toFixed(3)}`);
          failed = true;
        }
      }
    }
    if (failed) process.exitCode = 1;
    else console.log('check passed: no system scored below its recorded floor');
  }
  if (schema.startsWith('brain_mcp_ci_')) {
    await db.query(
      `insert into ${schema}.session_index_meta (key, value) values ('touched_at', now()::text)
       on conflict (key) do update set value = excluded.value`,
    );
  }
  if (values['prune-ci']) {
    // CI keeps one scratch index per version of the indexing code; drop the
    // ones no run has used for this many days.
    const days = Number(values['prune-ci']);
    const { rows } = await db.query<{ nspname: string }>(`select nspname from pg_namespace where nspname like 'brain\\_mcp\\_ci\\_%'`);
    for (const { nspname } of rows) {
      if (nspname === schema) continue;
      const { rows: t } = await db
        .query<{ value: string }>(`select value from ${nspname}.session_index_meta where key = 'touched_at'`)
        .catch(() => ({ rows: [] as { value: string }[] }));
      const at = t[0] ? new Date(t[0].value).getTime() : 0;
      if (Date.now() - at > days * 86_400_000) {
        await db.query(`drop schema ${nspname} cascade`);
        console.log(`dropped stale scratch index ${nspname}`);
      }
    }
  }
  void DEFAULT_RANK;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeSessionsDb());
