import { describe, expect, it } from 'vitest';
import type { Reply } from './state';
import { stripReplies } from './Transcript';

const r = (seq: number, kind: Reply['kind'], text: string, turnId = 't1'): Reply => ({ seq, turnId, text, kind });

describe('stripReplies', () => {
  it('lists the newest spoken line first, at most three', () => {
    const replies = [r(1, 'answer', 'one', 't0'), r(2, 'interject', 'Say Monday?'), r(3, 'prompt', 'Apply?'), r(4, 'ack', 'Done.')];
    expect(stripReplies(replies, null).map((x) => x.seq)).toEqual([4, 3, 2]);
  });
  it('skips the interject while its callout is on screen', () => {
    const replies = [r(1, 'interject', 'Say Monday?'), r(2, 'prompt', 'Apply?')];
    const callout = { turnId: 't1', text: 'Say Monday?', said: 'Tuesday', wordIndex: 12 };
    expect(stripReplies(replies, callout).map((x) => x.text)).toEqual(['Apply?']);
    expect(stripReplies(replies, { ...callout, turnId: 't2' }).map((x) => x.text)).toEqual(['Apply?', 'Say Monday?']);
  });
});
