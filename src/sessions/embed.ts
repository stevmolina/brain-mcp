/**
 * Meaning search for chats: turns text into vectors, on this machine.
 *
 * The model runs in-process (ONNX, through transformers.js), so no chat text
 * leaves the server for an embedding provider. Default model: multilingual E5
 * small (384 numbers per text, ~120 MB quantized), which places a Spanish
 * question near the English chat that answered it.
 *
 * `SESSION_EMBEDDINGS=off` turns it off; search then runs on keywords alone.
 * `SESSION_EMBED_MODEL` picks another model, `MODEL_DIR` where its files live
 * (the Docker image bakes them in at build time).
 */

export interface Embedder {
  /** Stored next to each vector: vectors of two models never mix. */
  readonly model: string;
  embed(texts: string[], kind: 'query' | 'passage'): Promise<number[][]>;
}

export const DEFAULT_EMBED_MODEL = 'Xenova/multilingual-e5-small';

/** E5 models were trained with these prefixes; other models take the text as is. */
function prefix(model: string, kind: 'query' | 'passage'): string {
  return /e5/i.test(model) ? `${kind}: ` : '';
}

type Extractor = (texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

export function localEmbedder(model = process.env.SESSION_EMBED_MODEL || DEFAULT_EMBED_MODEL): Embedder {
  let loading: Promise<Extractor> | undefined;
  const load = () => {
    loading ??= (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      if (process.env.MODEL_DIR) env.cacheDir = process.env.MODEL_DIR;
      // Offline in production: the image carries the files.
      if (process.env.MODEL_OFFLINE === '1') env.allowRemoteModels = false;
      return (await pipeline('feature-extraction', model, { dtype: 'q8' })) as unknown as Extractor;
    })().catch((error) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };
  return {
    model,
    async embed(texts, kind) {
      if (!texts.length) return [];
      const extract = await load();
      const out: number[][] = [];
      // Small batches keep memory flat inside a capped container.
      for (let i = 0; i < texts.length; i += 16) {
        const batch = texts.slice(i, i + 16).map((t) => prefix(model, kind) + t);
        out.push(...(await extract(batch, { pooling: 'mean', normalize: true })).tolist());
      }
      return out;
    },
  };
}

let current: Embedder | null | undefined;

/** The embedder in use, or null when meaning search is off. */
export function getEmbedder(): Embedder | null {
  if (current === undefined) current = process.env.SESSION_EMBEDDINGS === 'off' ? null : localEmbedder();
  return current;
}

/** Tests swap in a fake; null turns meaning search off. */
export function setEmbedder(embedder: Embedder | null | undefined, opts: { ready?: boolean } = {}): void {
  current = embedder;
  warmed = opts.ready && embedder ? embedder : null;
}

/** Postgres vector literal for pgvector: '[0.1,0.2,...]'. */
export function toVector(values: number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v.toFixed(6) : '0')).join(',')}]`;
}

let warmed: Embedder | null = null;
let warming: Promise<void> | undefined;

/**
 * Loads the model in the background (about 2 s from disk). Until it is
 * loaded, `readyEmbedder` returns null and search runs on keywords alone, so
 * the first call after a restart is never held up by the model.
 */
export function warmEmbedder(): Promise<void> {
  const embedder = getEmbedder();
  if (!embedder) return Promise.resolve();
  if (warmed === embedder) return Promise.resolve();
  warming ??= embedder
    .embed(['warm up'], 'query')
    .then(() => {
      warmed = embedder;
    })
    .catch((error) => {
      console.error(JSON.stringify({ level: 'warn', at: 'sessions.embed', message: String(error) }));
    })
    .finally(() => {
      warming = undefined;
    });
  return warming;
}

/** The embedder when its model is loaded, else null (and loading starts). */
export function readyEmbedder(): Embedder | null {
  const embedder = getEmbedder();
  if (!embedder) return null;
  if (warmed === embedder) return embedder;
  void warmEmbedder();
  return null;
}
