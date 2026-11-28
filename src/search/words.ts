/**
 * Words a question carries that say nothing about its subject, in English and
 * Spanish (Rioplatense included). Shared by claim search and chat search.
 *
 * Postgres drops its own English stopwords, but people also write to their
 * agents in Spanish, often without accents ("algun", "ahi"), with filler
 * ("che", "capo", "fijate") and with asks ("chequea", "can you check").
 * Every one of those words used to count as a term a match had to cover, so a
 * question with five filler words hid the one chat that had the rare word.
 *
 * Compared lower case and without accents.
 */

// Filler a claim query may lose: what the claim search dropped before, plus
// Spanish words that are never English words.
const ENGLISH_CLAIMS = `
  still yet currently now today please tell know anything everything something also ever just really actually
`;

// Asks and greetings people put in front of a message to an agent. Fine to
// drop from a chat question; too broad for claims ("help center", "show").
const ENGLISH_ASKS = `
  hey hi hello pls thanks thank can could would should you your me my we our us i im it its
  check look see find get give help show whats any some again remember recall did do does done about
  there here this that what which who how
`;

const SPANISH = `
  de que el en y a los se del las un por con no una su para es al lo como mas o pero sus le ha me si sobre
  este ya entre cuando todo esta ser tambien fue habia muy hasta desde estoy estas esta estan mi mis
  porque que han yo vez puede puedo puedes podes todos asi nos ni tiene tengo tenes tenemos tienen el uno
  donde bien mismo ese eso esa esos esas ahora cada e otro otra otros otras despues te tu tus vos aunque hace
  hacer siempre algo alguno alguna algun algunos algunas nada ningun ninguna aca alla ahi aqui alli
  cual cuales quien quienes cuanto cuanta cuantos cuantas
  che capo boludo amigo dale fijate fijarte fijame chequea chequear chequeame checa checkea checkear chequeas
  revisa revisar revisame mira mirame decime contame cuentame podrias podria quiero queria necesito
  bueno buenas hola gracias porfa porfavor onda tipo ver sabes sabe saber hiciste hicimos todavia
  hoy ayer
`;

// Spanish words that are also English words ("sin", "son", "era", "solo"):
// dropped from chat questions only.
const SPANISH_AMBIGUOUS = `la tan sin son era solo hay dime favor`;

const words = (text: string) => text.split(/\s+/).filter(Boolean);

/** Filler for chat questions: everything above. */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  ...words(ENGLISH_CLAIMS), ...words(ENGLISH_ASKS), ...words(SPANISH), ...words(SPANISH_AMBIGUOUS),
]);

/** Filler for claim queries: narrower, so real English words stay searchable. */
export const CLAIM_FILLER_WORDS: ReadonlySet<string> = new Set([...words(ENGLISH_CLAIMS), ...words(SPANISH)]);

/** Lower case, accents removed, punctuation trimmed. */
export function foldWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** True when a word says nothing about the subject of a chat question. */
export function isFiller(word: string): boolean {
  return FILLER_WORDS.has(foldWord(word));
}

/** True when a word says nothing about the subject of a claim query. */
export function isClaimFiller(word: string): boolean {
  return CLAIM_FILLER_WORDS.has(foldWord(word));
}
