// Payload shapes for droid_event, by kind. The wire schema keeps `payload: unknown`
// (non-breaking); producers (Lane C) and consumers (Lane D) should use these types.

/** kind 'plan'. Droid has no plan event: Lane C maps TodoWrite `todos` to `steps`. */
export type DroidPlanPayload = { steps: string[] };
/** kind 'step'. */
export type DroidStepPayload = { text: string };
/** kind 'tool'. A denied call also sets the event-level `denied: true`. reason e.g. 'outside-workspace' | 'tool-not-allowed'. */
export type DroidToolPayload = { tool: string; path?: string; denied?: boolean; reason?: string };
/** kind 'diff'. `diff` is unified (`git diff main..spec/<turnId>`), `file` is workspace-relative. */
export type DroidDiffPayload = { file: string; diff: string };
/** kind 'result'. */
export type DroidResultPayload = {
  ok: boolean;
  summary: string;
  /** true when the Droid turn failed after STAGED; the staged diff can still be applied. */
  failed?: boolean;
};

export type DroidPayloadByKind = {
  plan: DroidPlanPayload;
  step: DroidStepPayload;
  tool: DroidToolPayload;
  diff: DroidDiffPayload;
  result: DroidResultPayload;
};
