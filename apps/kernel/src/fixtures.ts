import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository fixtures directory (fixtures/scenarios), resolved from the kernel source tree. */
export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "scenarios");

export const DEFAULT_REPLAY_FIXTURE = "scenario-a-constrained-acquisition";
