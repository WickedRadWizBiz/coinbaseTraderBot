import { kalshiRateLimiter, BucketType, RequestPriority } from './kalshiRateLimiter';
import { backpressureQueue } from './backpressureQueue';

export class RateLimiter {
  constructor(private maxRequests: number = 5, private windowMs: number = 1000) {}

  public async wait(options?: { path?: string; method?: string; priority?: RequestPriority }) {
    const path = options?.path || '/trade-api/v2/markets';
    const method = options?.method || 'GET';
    const priority = options?.priority || 'LOW';

    return kalshiRateLimiter.execute(
      async () => {},
      { path, method, priority }
    ).catch(() => {});
  }
}

export { kalshiRateLimiter, backpressureQueue };
