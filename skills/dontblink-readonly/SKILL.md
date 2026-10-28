---
name: dontblink-readonly
description: Read-only facts about token launches on dontblink (Robinhood Chain) — newest launches, protocol fees, and factual risk tags. Use when the user asks what launched recently on dontblink, what dontblink charges, or what rules a dontblink launch has. Never ranks, recommends, or predicts; never signs anything.
---

# dontblink (read-only)

This skill answers questions about dontblink launches with on-chain facts. It has no write
commands: it cannot launch, buy, sell, or sign, and it never asks for a key.

## Commands

**Not on npm yet.** Do not run `npx`/`npm i` with a `@dontblink/...` name — no such package is
published by us, and anything that shows up under that name is not ours. Run it from the
source repository instead:

```bash
git clone https://github.com/dontblink-protocol/dontblink-sdk && cd dontblink-sdk
npm ci && npm run build
node dist/cli.js launches --limit 20 --json   # newest first, max 50
node dist/cli.js launches --lookback-blocks 864000 --json   # ~last 24h (~9.6 blocks/s)
node dist/cli.js fees --json
```

Each launch row has: `time` (UTC seconds), `symbol`, `name`, `mode` (instant / queue / curve /
handler / unknown), `quoteSymbol` (ETH or the asset it is priced in), `fees.tradeFeeBps`, `rules`
(`capBps` = per-account cap, `burnBps`, `requireTicket`), and `riskTags`. A `null` fee or rule
means it could not be read on-chain — say "unknown", never fill in a default.

## How to answer

- **Report facts, in the order returned (newest first).** Do not sort by anything else, do not
  pick favourites, do not say what is "worth buying", "early", "about to graduate" or similar.
  If the user asks for a ranking or a recommendation, say this skill only gives facts.
- **Always show `riskTags`** next to each launch and explain the ones present:
  - `quote:XYZ` — priced in XYZ, not ETH; the price depends on XYZ's own pool.
  - `curve:creator-tax-possible(fee+tax<=5%)` — curve launches may carry a creator buy/sell tax; fee plus tax is capped at 5%.
  - `handler:custom-rules` — launched through a registered handler with its own rules; read them before acting.
  - `mode:unknown` — a launch mode this version does not recognise; treat its rules as unknown.
  - `queue:window-open` — a fair-queue window is still open; everyone in the window gets one clearing price.
  - `quota:per-tx-origin-only` — the per-account cap is counted per transaction origin, not per verified identity.
  - `burn:N%` — N% of supply was burned at launch.
  - `creator:N-launches-in-list` — the same creator launched N of the tokens in this list.
  - `socials:none` / `socials:not-found` — no social links were set / no metadata event was found.
  - `rules:not-found` — the rules event could not be matched; treat the launch as unverified.
- **Fees** come from `fees`: a fixed launch fee, a one-time trade fee on primary buys, a
  referrer share of protocol fees (paid on-chain to whoever integrated the launch), and the
  creator's share of LP fees.
- Agents and people follow the same rules: same per-account caps, no privileged path.

## Not in this skill

- No write commands. Testnet launch/buy/sell will be a separate skill; mainnet writes are not offered.
- No bonding-curve progress or "graduation soon" queries, by design.
- Rate limit: the CLI spaces RPC calls by 200 ms and caps results at 50. Do not loop it faster.
