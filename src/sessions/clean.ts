/**
 * What a chat says, without what tools pasted into it.
 *
 * Agent apps put long instructions in front of the person's message: Pokebots
 * sends ~10-30k characters of developer instructions, saved memories, a Second
 * Brain block and the recent transcript; coding agents paste rules files,
 * environment blocks and task notifications. That text is the same in hundreds
 * of chats, so a search over raw turns matches every chat on noise and ranks
 * the one that is really about the question below them.
 *
 * Three passes, all on text only (no tenant names live here):
 *
 *  1. Markers. A Pokebots turn keeps only what follows its last
 *     `--- current message ---`; a Second Brain block is cut out.
 *  2. Tags. Any `<tag ...>...</tag>` block is removed, except the wrappers that
 *     hold the person's own words (`<user_query>` and friends), which are
 *     unwrapped. Lone opening or closing tags are dropped too.
 *  3. Boilerplate. A line that appears in many of the same person's chats is
 *     pasted, not written. `boilerplateLines` finds them across a corpus, and
 *     `cleanTurn` drops them when given that set.
 */
import { createHash } from 'node:crypto';

/** Tags whose content is the person's own message: unwrapped, not removed. */
const KEEP_TAGS = new Set(['user_query', 'user_request', 'user_message', 'user_input', 'request', 'query', 'message']);

/** Marker after which a Pokebots turn holds the person's message. */
const CURRENT_MESSAGE = /^[ \t]*---[ \t]*current message[ \t]*---[ \t]*$/gim;
/** A Second Brain block, from its opening marker to its closing one (or the next marker). */
const BRAIN_BLOCK = /---[ \t]*context from your Second Brain[ \t]*---[\s\S]*?(?:---[ \t]*end of Second Brain context[ \t]*---|(?=\n[ \t]*---[ \t][^\n]{2,50}[ \t]---[ \t]*\n)|$)/gi;
/** `--- name ---` section markers some apps write between pasted parts. */
const SECTION_MARKER = /^[ \t]*---[ \t][^\n]{2,50}[ \t]---[ \t]*$/gm;

/** A line must be at least this long, and seen in this many chats, to count as pasted. */
export const BOILERPLATE_MIN_CHARS = 25;
export const BOILERPLATE_MIN_CHATS = 4;

export function lineKey(line: string): string | null {
  const norm = line.replace(/\s+/g, ' ').trim().toLowerCase();
  if (norm.length < BOILERPLATE_MIN_CHARS) return null;
  return createHash('sha1').update(norm).digest('base64url').slice(0, 16);
}

/** Removes markers and tagged blocks. Pure text in, text out. */
export function stripInjected(text: string): string {
  let out = text;

  // 1. Pokebots: what follows the last "--- current message ---" is the message.
  const marks = [...out.matchAll(CURRENT_MESSAGE)];
  if (marks.length) {
    const last = marks[marks.length - 1]!;
    out = out.slice(last.index! + last[0].length);
  }
  out = out.replace(BRAIN_BLOCK, ' ');

  // 2. Tagged blocks, innermost first, until nothing changes. A keep tag is
  // unwrapped; any other closed block goes. Bounded, so odd input cannot loop.
  const block = /<([A-Za-z][\w:.-]{0,60})(?:\s[^<>]{0,400})?>([\s\S]*?)<\/\1\s*>/g;
  for (let i = 0; i < 8; i += 1) {
    const next = out.replace(block, (_whole, tag: string, inner: string) =>
      KEEP_TAGS.has(tag.toLowerCase()) ? `\n${inner}\n` : '\n',
    );
    if (next === out) break;
    out = next;
  }
  // Lone tags left over (an opening tag whose block never closed, or a stray close).
  out = out.replace(/<\/?[A-Za-z][\w:.-]{0,60}(?:\s[^<>]{0,400})?\/?>/g, ' ');
  out = out.replace(SECTION_MARKER, '');
  return out;
}

/**
 * One turn's text as the search should see it. `boilerplate` is the set of
 * line keys seen in many chats (from `boilerplateLines`); without it only the
 * marker and tag passes run.
 */
export function cleanTurn(text: string, boilerplate?: ReadonlySet<string>): string {
  let out = stripInjected(text);
  if (boilerplate && boilerplate.size) {
    out = out
      .split('\n')
      .filter((line) => {
        const key = lineKey(line);
        return !key || !boilerplate.has(key);
      })
      .join('\n');
  }
  return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Counts, for each long line, how many different chats it appears in, and
 * returns the keys of lines seen in `minChats` or more. Run over one owner's
 * user turns after `stripInjected`: what is left and repeated is pasted.
 */
export class BoilerplateCounter {
  private seen = new Map<string, number>();

  addChat(texts: string[]): void {
    const keys = new Set<string>();
    for (const text of texts) {
      for (const line of stripInjected(text).split('\n')) {
        const key = lineKey(line);
        if (key) keys.add(key);
      }
    }
    for (const key of keys) this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
  }

  result(minChats = BOILERPLATE_MIN_CHATS): Set<string> {
    const out = new Set<string>();
    for (const [key, n] of this.seen) if (n >= minChats) out.add(key);
    return out;
  }
}

/**
 * Text for the keyword index, and for a query on it: dotted, slashed and snake
 * names read as their parts, so "huevsite.io" is found by "huevsite" and
 * "src/auth/access.ts" by "access". Both sides go through it, so they agree.
 */
export function splitIdentifiers(text: string): string {
  return text.replace(/([\p{L}\p{N}])[._/:@]+(?=[\p{L}\p{N}])/gu, '$1 ');
}
