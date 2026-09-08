import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { stopOwnedChild, waitForOwnedChild } from "../../rehearsal/owned-process.ts";

it("cleans up its own child when startup readiness fails", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  try {
    await expect(
      waitForOwnedChild(child, async () => {
        throw new Error("simulated readiness failure");
      }),
    ).rejects.toThrow("simulated readiness failure");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await expect(stopOwnedChild(child)).resolves.toBeUndefined();
  } finally {
    await stopOwnedChild(child);
  }
});
