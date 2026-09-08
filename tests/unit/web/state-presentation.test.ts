import { describe, expect, it } from "vitest";
import { commandState, proposalState } from "../../../apps/web/src/states.ts";

describe("execution status presentation", () => {
  it("does not infer missing fills from ACCEPTED, which persists after a full fill", () => {
    const accepted = commandState("ACCEPTED");
    expect(accepted.label).toBe("ACCEPTED");
    expect(accepted.note).toContain("fill status is shown separately");
    expect(accepted.tone).not.toBe("green");
  });

  it("does not claim submission when an arm commit can precede a crash before send", () => {
    const armed = commandState("ARMED");
    expect(armed.label).toBe("ARMED");
    expect(armed.note).toContain("dispatch or venue response may be pending");
    expect(armed.note).not.toMatch(/sent once|submitted/);
  });

  it("does not infer pending dispatch from a proposal's persistent COMMAND_CREATED state", () => {
    const proposal = proposalState("COMMAND_CREATED");
    expect(proposal.note).toContain("see command and order for execution status");
    expect(proposal.note).not.toMatch(/awaiting dispatch|not submitted|not filled/);
  });
});
