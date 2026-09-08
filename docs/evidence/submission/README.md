# Recorded SHADOW run

This evidence belongs to the [submission video](../../submission/README.md), recorded on 2026-09-08 from application commit `7dd4736190b2809255454222165d7c0845e4a2b7`, engine `0.1.2`. Later documentation commits do not change the recorded application.

The actual operator browser approved a virtual order and stopped the account. The request was sent through the scoped agent API by the recording driver. The film's diagram and request cards explain captured values; they are not a ChatGPT or Claude conversation. The video has AI-generated English narration and 36 timed caption cues.

| Recorded value | Result |
|---|---|
| Account alias | `film-mtsv3igt` |
| Market source | `BINANCE_PUBLIC_REST` |
| Market observation | 2026-09-08 16:12:26.622 UTC; SOLUSDT bid 103.74 / ask 103.75 |
| Request | BUY SOLUSDT, LIMIT IOC, 50 USDT, limit price 103.96 |
| Agent budget | 30 USDT |
| Decision | `COUNTERPROPOSE`, limiting rule `LEASE_BUDGET` |
| Candidate | 0.288 SOL × 103.96 = 29.94048 USDT |
| Fee reserve / total hold | 0.02994048 / 29.97042048 USDT |
| Execution | Local paper venue; no exchange write |
| Observed virtual fill | 0.288 SOL × 103.70 = 29.8656 USDT |
| Actual virtual fee | 0.0298656 USDT |
| Ending holdings | 0.288 SOL and 970.1045344 USDT |
| Ending account state | PAUSED; no outstanding command |
| Offline verifier | 9/9 checks passed; 18 events, 1 replayed receipt, 1 command, 1 fill |

## Re-verify independently

From the repository root, with the pinned dependencies installed:

```bash
pnpm verify:receipt -- docs/evidence/submission/run-export.json
```

This command needs no database, exchange connection, or model key. It replays the archived evaluator input and checks the event chain, receipt fingerprints, references, reservations, fill accounting, ledger conservation, and export sanitization. Without an independently retained final hash, the chain check proves internal consistency only.

The README's live-market bootstrap was separately exercised on Node 24.20.0 against a fresh account on 2026-09-08. Its 50 USDT request reached approval with a 29.99132136 USDT total reservation; `doctor`, the recorded-run verifier, and local documentation targets passed. See the [reproduction check](reproduction-check.json). This check is separate from the filmed account.

- [Submitted request and decision](request.json)
- [Complete sanitized run export](run-export.json)
- [Verifier report](verification.json)
- [Video provenance](video-provenance.json)
- [Video playback and format checks](video-quality-check.json)

The video is 1920 × 1080 at 30 fps, H.264/AAC, 105.152 seconds including the audio encoder tail. Its SHA-256 is `e21fde1fc14eb5ffe9ba00b92ac4393eb3d307ece9ccd25b17090d2fcb9c750f`. Browser playback and seeking passed, the complete video decoded without errors, and no caption timing overlaps were found.

Conflicts, quarantine, and response-loss recovery are verified separately in the [three-run REPLAY rehearsal](../demo/g7-review.md); they are not depicted as live-market faults in this video.
