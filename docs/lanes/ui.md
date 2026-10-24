## Lane D: HUD + demo polish (`lane/ui`, apps/web, start Sat ~noon once A and B have real events)

Goal: the thing judges look at. One screen, dark, no scrolling, legible from 4 feet away.

Layout (left to right)
1. Transcript column: partial text grows word by word, finalized turns above it. The word that triggered an interjection gets highlighted.
2. Belief panel: intent as a big label, confidence as a bar that visibly rises across the sentence, entities as chips, top 3 Moss hits with snippet and `ms` badge.
3. Executor panel: state machine as a horizontal stepper, Droid plan/steps streaming in, denied tool calls shown in red, diff rendered as a real diff view, Apply / Discard buttons (voice "yes" also works).
4. Top bar: live counters, "Moss queries this turn", "avg retrieval ms", "time to first audio".

Also
- `DEMO_MODE` toggle that drives the whole UI from the replay harness.
- 30 s screen recording of utterance 1 for the Moss social post.
- Read the superpowers frontend-design skill if present, keep one accent color, use a monospace for the HUD numbers.
