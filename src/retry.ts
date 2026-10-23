import { RateLimited, PlatformDown } from './adapters/types.ts'
import { sleep } from './adapters/mock.ts'

export type RetryOptions = {
  attempts?: number // 最多試幾次（含第一次）
  baseMs?: number // 退避起點，之後每次加倍
  onRetry?: (attempt: number, err: unknown) => void
}

// 指數退避重試。只有「可以重試」的錯誤（限流、平台掛掉）才會重試，其他錯誤直接丟出。
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 4
  const baseMs = options.baseMs ?? 10
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!isRetryable(err) || attempt === attempts) throw err
      lastErr = err
      options.onRetry?.(attempt, err)
      const wait = err instanceof RateLimited ? err.retryAfterMs : baseMs * 2 ** (attempt - 1)
      await sleep(wait)
    }
  }
  throw lastErr
}

function isRetryable(err: unknown): boolean {
  return err instanceof RateLimited || err instanceof PlatformDown
}
