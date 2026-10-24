import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, lastWords } from './normalize.js';

test('normalize lowercases, maps number words, strips punctuation', () => {
  assert.equal(
    normalize("Draft a message to Priya saying, I'll see her Thursday at two."),
    "draft a message to priya saying i'll see her thursday at 2",
  );
});

test('normalize ignores trailing punctuation', () => {
  assert.equal(normalize('Friday,'), normalize('friday'));
});

test('normalize strips quotes but keeps intra-word apostrophes', () => {
  assert.equal(normalize('"Don\'t go," she said!'), "don't go she said");
});

test('normalize handles Ink example with digits', () => {
  assert.equal(
    normalize("Draft a message to Priya saying, I'll see her Thursday at 2 for the Q3 deck review."),
    "draft a message to priya saying i'll see her thursday at 2 for the q3 deck review",
  );
});

test('normalize maps zero..twelve and collapses whitespace', () => {
  assert.equal(normalize('  zero one   twelve  '), '0 1 12');
  assert.equal(normalize('eleven'), '11');
});

test('lastWords returns the last n words', () => {
  assert.equal(lastWords('a b c d e f g h', 6), 'c d e f g h');
  assert.equal(lastWords('a b', 6), 'a b');
});
