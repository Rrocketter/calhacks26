// Latest mic RMS (0..1) for the top bar meter. Capture writes it, the meter reads it per frame.
let rms = 0;

export const micLevel = {
  get: () => rms,
  set: (v: number) => {
    rms = v;
  },
};
