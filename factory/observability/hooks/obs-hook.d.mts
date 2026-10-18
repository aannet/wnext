export function ulidFrom(seed: string): string;
export function sumTranscript(text: string): { tokens_in: number; tokens_out: number; tokens_cache_read: number; tokens_cache_write: number; model: string | null };
export function costOf(model: string, t: { tokens_in: number; tokens_out: number; tokens_cache_read: number; tokens_cache_write: number }, prices?: Record<string, number[]>): number;
export function buildEvent(
  payload: Record<string, unknown>,
  env: Record<string, string | undefined>,
  io?: { now?: Date; readFile?: (path: string) => string | null; prices?: Record<string, number[]> },
): Record<string, unknown> | null;
