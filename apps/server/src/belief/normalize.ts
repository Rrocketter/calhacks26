const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
};

export function normalize(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    // drop apostrophes that are not between two word characters
    .replace(/(?<![\p{L}\p{N}])'|'(?![\p{L}\p{N}])/gu, ' ')
    .replace(/[,.!?;:"`]/g, ' ');
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => NUMBER_WORDS[w] ?? w)
    .join(' ');
}

export function lastWords(text: string, n: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(-n).join(' ');
}
