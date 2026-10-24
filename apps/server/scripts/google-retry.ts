// Retry for Google API rate limits (Gmail "Units per minute per user" and friends):
// exponential backoff with jitter, honoring Retry-After when Google sends one.
type ApiError = {
  status?: number;
  message?: string;
  errors?: { reason?: string }[];
  response?: {
    status?: number;
    headers?: Record<string, string | undefined>;
    data?: { error?: { errors?: { reason?: string }[] } };
  };
};

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as ApiError;
  const status = e.status ?? e.response?.status;
  if (status === 429) return true;
  const reasons = [...(e.errors ?? []), ...(e.response?.data?.error?.errors ?? [])].map((x) => x.reason ?? '');
  if (reasons.some((r) => RATE_REASONS.has(r))) return true;
  return /quota exceeded|rate limit exceeded/i.test(e.message ?? '');
}

const BASE_MS = 1000;
const CAP_MS = 32000;

export function backoffMs(attempt: number, err: unknown, rand: () => number = Math.random): number {
  const after = Number((err as ApiError | undefined)?.response?.headers?.['retry-after']);
  if (after > 0) return Math.min(after * 1000, 60000);
  const exp = Math.min(BASE_MS * 2 ** (attempt - 1), CAP_MS);
  return exp === CAP_MS ? CAP_MS : exp + Math.floor(rand() * BASE_MS);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { tries?: number; sleep?: (ms: number) => Promise<void>; rand?: () => number; log?: (msg: string) => void } = {},
): Promise<T> {
  const tries = opts.tries ?? 7;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? console.log;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries || !isQuotaError(err)) throw err;
      const ms = backoffMs(attempt, err, opts.rand);
      log(`[google] rate limited, retry ${attempt}/${tries - 1} in ${ms}ms`);
      await sleep(ms);
    }
  }
}
