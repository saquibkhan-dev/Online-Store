import type { Logger } from "./logger";

/** Runs cleanup steps once on SIGTERM/SIGINT, in order, with an overall deadline. */
export function onShutdown(logger: Logger, steps: Array<[string, () => Promise<unknown>]>, timeoutMs = 15_000): void {
  let started = false;
  const run = async (signal: string) => {
    if (started) return;
    started = true;
    logger.info({ signal }, "shutting down");
    const deadline = setTimeout(() => {
      logger.error("shutdown timed out");
      process.exit(1);
    }, timeoutMs);
    deadline.unref();
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (err) {
        logger.error({ err, step: name }, "shutdown step failed");
      }
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => void run("SIGTERM"));
  process.once("SIGINT", () => void run("SIGINT"));
}
