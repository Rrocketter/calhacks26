import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { HaikuIntentLlm, SYSTEM } from './haiku.js';

// Live probe 2026-10-24: without this rule Haiku rated "Draft a message" draft_message at 0.6
// (fused 0.76 < INTERJECT_AT), so the demo lock could not interject. Entity completeness is
// already covered by Moss support in the fused confidence.
test('system prompt rates intent confidence independent of missing entities', async () => {
  assert.match(SYSTEM, /Rate the intent only, not whether entities are complete/);
  assert.match(SYSTEM, /0\.85 or higher even if the person, day, or file is still missing/);

  let sent: { system?: unknown } | undefined;
  const fake = {
    messages: {
      create: async (req: { system?: unknown }) => {
        sent = req;
        return {
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: JSON.stringify({ intent: 'draft_message', entities: [], claims: [], confidence: 0.9 }),
            },
          ],
        };
      },
    },
  } as unknown as Anthropic;
  const { result } = await new HaikuIntentLlm(fake).classify({ partial: 'Draft a message', topHits: [] });
  assert.equal(sent?.system, SYSTEM);
  assert.equal(result.confidence, 0.9);
});
