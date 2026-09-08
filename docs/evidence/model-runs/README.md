# Model-run evidence status

Reviewed on 2026-09-08. The four historical JSON artifacts in this directory are preserved without alteration.

The `20260908T081607Z-session-proposal.json` metadata says the proposal was authored from an **08:11:29Z** context, then bound to a newer dump. Its rationale quotes bid **102.64**, ask **102.65**, and **336 SOL** of depth. The referenced snapshot in `20260908T081607Z-context.json` was received at **08:16:08.399Z** and instead contains bid **102.68**, ask **102.69**, and ask quantity **345.622 SOL**. The saved runner trace repeats the older rationale and the newer context hash.

These artifacts establish that a supplied proposal file passed runner schema/hash checks, entered the kernel, and obtained the recorded paper outcome. They do **not** verify that a model generated that proposal from the exact fresh context named in the trace. The `SUPPORTED_AGENT_SESSION` value is the historical runner label, not independent proof of that context-to-model link. This classification does not establish how the original proposal was authored.

A qualifying replacement run must retain the exact context shown to the model and its unmodified output, including the original observation references. If the model takes too long, preserve the resulting stale-data denial. Do not copy a later observation ID or context hash into an earlier response to make it appear fresh. Store any replacement as new evidence alongside these historical files.
