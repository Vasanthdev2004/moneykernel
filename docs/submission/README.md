# MoneyKernel — submission package

**Track A · Binance Agent OS Mini Hackathon · 2026-09-08**

MoneyKernel gives an AI agent a bounded spending lease, independently evaluates its trade requests, requires exact human approval, and records the resulting order, fill, and ledger entries in a verifiable receipt.

## Links for reviewers

| Item | Link |
|---|---|
| Source | [github.com/Vasanthdev2004/moneykernel](https://github.com/Vasanthdev2004/moneykernel) |
| Video, 1:45, English captions | [1080p MP4](https://github.com/Vasanthdev2004/moneykernel/releases/download/hackathon-2026-09-08/MoneyKernel-Demo-1080p.mp4) |
| Download package | [Video, subtitles, narration, editable Remotion project and evidence](https://github.com/Vasanthdev2004/moneykernel/releases/download/hackathon-2026-09-08/MoneyKernel-Submission-Package.zip) |
| Release | [Hackathon submission candidate](https://github.com/Vasanthdev2004/moneykernel/releases/tag/hackathon-2026-09-08) |
| Recording evidence | [Actual SHADOW run and verification](../evidence/submission/README.md) |
| Binance supported-agent observation | [Codex plugin read with exact tool provenance](../evidence/binance-codex-market-observation-20260908T125734Z.json) |
| Architecture | [Design and package boundaries](../architecture.md) |
| License | [MIT](../../LICENSE) |

## Paste-ready project description

MoneyKernel is a deterministic capital-control gateway for AI trading agents. An agent receives a spending lease and submits a structured trade request. The kernel checks its authority, available cash, market freshness, and portfolio limits; reserves resources atomically; and requires a human to approve the exact candidate. It then reconciles execution into a readable, independently verifiable decision record.

The video demonstrates a 50 USDT SOL request against a 30 USDT agent budget, a smaller policy-compliant candidate, exact approval, a live-book paper fill, receipt verification, and Stop new orders. The operator console includes holdings, approvals, agents and leases, activity, and system provenance, with light and dark themes. Additional verified REPLAY scenarios cover conflicting agents, quarantine, and recovery after a lost response.

The project uses live Binance public REST data in SHADOW mode with virtual funds. A separate supported Codex session verified a read-only Binance plugin market observation. The custom backend Agent OS OAuth client was refused by Binance's allowlist, so a backend-owned Agent OS session is not claimed. There is no mainnet order path. This is an open-source hackathon prototype with a hardened private SHADOW deployment, not a qualified real-money trading system.

## Short pitch

AI agents can propose trades. MoneyKernel decides whether they have the authority and resources to act, asks for exact human approval, and records what actually happened. Give AI agents capital, not blind trust.

## Post draft

Attach the MP4 to a reply or quote-repost of the [official announcement](https://x.com/binance/status/2094810011557838988). This draft assumes the video is attached:

```text
MoneyKernel: give AI agents capital, not blind trust.

An agent requests 50 USDT. Its budget is 30. MoneyKernel reduces the request, requires exact approval, and records a verifiable receipt.

Live Binance data. Virtual execution.
https://github.com/Vasanthdev2004/moneykernel
```

Use the project description above for relevant survey fields. Field names after login have not been verified; do not treat these paragraphs as the survey's exact questionnaire.

## Owner submission steps

The [official instructions](https://www.binance.com/en/blog/community/8802181509900814931), checked on 2026-09-08, require following [@Binance](https://x.com/binance), reposting the announcement, a Track A reply or quote-repost containing the video/demo and GitHub where applicable, and completion of the [Binance survey](https://www.binance.com/en/survey/2913aa200aac462c89a737779393f3d4). The deadline is **2026-09-08 23:59 UTC / 2026-09-09 05:29 IST**.

- [ ] Confirm your Binance account and jurisdiction are eligible under the announcement's terms.
- [ ] Watch the final video and keep its live-data/virtual-execution labels intact.
- [ ] Follow @Binance and repost the official announcement.
- [ ] Publish the reply or quote-repost with the attached video and repository link; retain the post URL.
- [ ] Log in to the official survey, choose the appropriate track, and supply your own account details and the final links.
- [ ] Submit the survey and retain its completion confirmation before the deadline.

The survey's public landing page was inspected: it requires Binance login before displaying the questions. No post or survey submission has been made by this repository preparation. Whether the demonstrated supported-agent read and separately labelled public REST path meet Track A's Agent OS criterion remains for the organizer to assess; the entry must retain the integration disclosure above.
