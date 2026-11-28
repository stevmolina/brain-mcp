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

const ENGLISH = `
  hey hi hello please pls thanks thank can could would should you your me my we our us i im it its
  check look see tell know show find get give help
  still yet currently now today anything everything something also ever just really actually whats
  any some again remember recall did do does done about there here this that what which who how
`;

const SPANISH = `
  de la que el en y a los se del las un por con no una su para es al lo como mas o pero sus le ha me si sin sobre
  este ya entre cuando todo esta ser son tambien fue habia era muy hasta desde estoy estas esta estan mi mis
  porque que solo han yo hay vez puede puedo puedes podes todos asi nos ni tiene tengo tenes tenemos tienen el uno
  donde bien mismo ese eso esa esos esas ahora cada e otro otra otros otras despues te tu tus vos aunque hace
  hacer tan siempre algo alguno alguna algun algunos algunas nada ningun ninguna aca alla ahi aqui alli
  cual cuales quien quienes como cuanto cuanta cuantos cuantas
  che capo boludo amigo dale fijate fijarte fijame chequea chequear chequeame checa checkea checkear chequeas
  revisa revisar revisame mira mirame decime dime contame cuentame podrias podria quiero queria necesito
  bueno buenas hola gracias porfa porfavor favor onda tipo ver sabes sabe saber hiciste hicimos todavia
  hoy ayer
`;

export const FILLER_WORDS: ReadonlySet<string> = new Set(`${ENGLISH} ${SPANISH}`.split(/\s+/).filter(Boolean));

/** Lower case, accents removed, punctuation trimmed. */
export function foldWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** True when a word says nothing about the question's subject. */
export function isFiller(word: string): boolean {
  return FILLER_WORDS.has(foldWord(word));
}
