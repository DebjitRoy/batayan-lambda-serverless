import { newStemmer } from "snowball-stemmers";
const stemmer = newStemmer("english");
// MongoDB's default English stop words; do not stem Bengali text.
const stopWords = new Set("a about above after again against all am an and any are aren't as at be because been before being below between both but by can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves".split(" "));
const normalize = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
function tokens(value: string): string[] {
  // Preserve Bengali combining marks; remove diacritics only for Latin tokens.
  return (value.toLowerCase().match(/[\p{L}\p{M}\p{N}]+(?:'[\p{L}]+)*/gu) ?? []).map(word => /^[a-z\u00c0-\u024f]/i.test(word) ? normalize(word) : word);
}
const stem = (word: string) => /^[a-z']/i.test(word) ? stemmer.stem(word) : word;
export function matchesSeriesSearch(fields: string[], query: string): boolean {
  const documents = fields.map(tokens);
  const words = new Set(documents.flat().filter(word => !stopWords.has(word)).map(stem));
  const positive: string[] = [], negative: string[] = [], phrases: string[][] = [], excludedPhrases: string[][] = [];
  for (const match of query.matchAll(/(-?)"([^"]+)"|(-?)([^\s"]+)/g)) {
    if (match[2] !== undefined) (match[1] ? excludedPhrases : phrases).push(tokens(match[2]));
    else for (const word of tokens(match[4]!)) if (!stopWords.has(word)) (match[3] ? negative : positive).push(stem(word));
  }
  const phraseFound = (phrase: string[]) => documents.some(doc => doc.some((_, index) => phrase.every((word, offset) => doc[index + offset] === word)));
  if (negative.some(word => words.has(word)) || excludedPhrases.some(phraseFound)) return false;
  if (!phrases.every(phraseFound)) return false;
  return phrases.length > 0 || positive.some(word => words.has(word));
}
