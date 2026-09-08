import type { ChildProcess } from "node:child_process";

/** Kill only the child this rehearsal created; repeated cleanup never looks up a port or stale PID. */
export async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new Error("owned kernel did not exit after termination")), 10_000);
    child.once("exit", onExit);
    child.once("error", onError);
    child.kill("SIGKILL");
  });
}

/** Startup owns cleanup until it can return the live child to the caller's finally block. */
export async function waitForOwnedChild(child: ChildProcess, ready: () => Promise<void>): Promise<void> {
  let spawnError: Error | undefined;
  const onError = (error: Error) => {
    spawnError = error;
  };
  child.on("error", onError);
  try {
    await ready();
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("owned kernel exited during startup");
  } catch (error) {
    await stopOwnedChild(child);
    throw error;
  } finally {
    child.removeListener("error", onError);
  }
}
