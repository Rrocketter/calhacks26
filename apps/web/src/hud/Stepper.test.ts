import { describe, expect, it } from 'vitest';
import { stateLabel, terminalLabel } from './Stepper';

describe('stepper labels', () => {
  it('names states plainly in Product and raw in Engineering', () => {
    expect(stateLabel('BELIEF_FORMING', 'product')).toBe('Understanding');
    expect(stateLabel('BELIEF_FORMING', 'engineering')).toBe('BELIEF FORMING');
  });
  it('shows one terminal label that changes with the outcome', () => {
    expect(terminalLabel(['LISTENING', 'STAGED'], 'product')).toBe('Applied');
    expect(terminalLabel(['STAGED', 'ROLLED_BACK'], 'product')).toBe('Discarded');
    expect(terminalLabel(['STAGED', 'COMMITTED'], 'product')).toBe('Applied');
    expect(terminalLabel(['STAGED', 'ROLLED_BACK'], 'engineering')).toBe('ROLLED BACK');
  });
});
