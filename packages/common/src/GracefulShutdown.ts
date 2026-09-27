type ShutdownHandler = () => Promise<void> | void;

/**
 * Runs registered handlers in reverse order on SIGINT/SIGTERM, then exits.
 * Register resources as you open them (DB pool, gRPC stream, HTTP server).
 */
export class GracefulShutdown {
  private static handlers: { name: string; fn: ShutdownHandler }[] = [];
  private static installed = false;
  private static shuttingDown = false;

  static register(name: string, fn: ShutdownHandler): void {
    this.handlers.push({ name, fn });
    this.install();
  }

  static isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  static async shutdown(exitCode = 0, timeoutMs = 15_000): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const timer = setTimeout(() => process.exit(exitCode || 1), timeoutMs);
    for (const { fn } of [...this.handlers].reverse()) {
      try {
        await fn();
      } catch {
        // keep shutting down the remaining resources
      }
    }
    clearTimeout(timer);
    process.exit(exitCode);
  }

  private static install(): void {
    if (this.installed) return;
    this.installed = true;
    process.once('SIGINT', () => void this.shutdown(0));
    process.once('SIGTERM', () => void this.shutdown(0));
  }
}
