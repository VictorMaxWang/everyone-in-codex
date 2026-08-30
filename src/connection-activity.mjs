function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 等待所有共享执行面空闲；只返回计数和等待时间，不传播任务标题或请求正文。 */
export class ConnectionActivityProbe {
  constructor({
    routerHealthUrl,
    fetchImpl = globalThis.fetch,
    fusionActivity,
    now = Date.now,
    sleep = delay,
    intervalMs = 500,
  } = {}) {
    if (
      typeof routerHealthUrl !== "string"
      || typeof fetchImpl !== "function"
      || typeof fusionActivity !== "function"
      || typeof now !== "function"
      || typeof sleep !== "function"
      || !Number.isSafeInteger(intervalMs)
      || intervalMs < 1
    ) {
      throw new Error("connection_activity_dependency_invalid");
    }
    this.routerHealthUrl = routerHealthUrl;
    this.fetchImpl = fetchImpl;
    this.fusionActivity = fusionActivity;
    this.now = now;
    this.sleep = sleep;
    this.intervalMs = intervalMs;
  }

  async inspect({ signal } = {}) {
    const response = await this.fetchImpl(this.routerHealthUrl, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!response.ok) throw new Error("router_health_unavailable");
    const router = await response.json();
    const routerActive = Number(router?.activity?.activeCount);
    const fusion = await this.fusionActivity();
    const fusionActive = Number(fusion?.activeCount);
    if (
      !Number.isSafeInteger(routerActive)
      || routerActive < 0
      || !Number.isSafeInteger(fusionActive)
      || fusionActive < 0
    ) {
      throw new Error("connection_activity_invalid");
    }
    // Fusion 请求通常也计入 Router；取最大值避免在 UI 中重复计数。
    return Object.freeze({ activeCount: Math.max(routerActive, fusionActive) });
  }

  async waitUntilIdle({ timeoutMs, signal } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("connection_activity_timeout_invalid");
    }
    const startedAt = this.now();
    while (this.now() - startedAt < timeoutMs) {
      if (signal?.aborted) throw new Error("connection_apply_cancelled");
      if ((await this.inspect({ signal })).activeCount === 0) {
        return Object.freeze({ idle: true, waitedMs: this.now() - startedAt });
      }
      const remaining = timeoutMs - (this.now() - startedAt);
      if (remaining <= 0) break;
      await this.sleep(Math.min(this.intervalMs, remaining));
    }
    return Object.freeze({ idle: false, waitedMs: this.now() - startedAt });
  }
}
