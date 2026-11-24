# Pump.fun Paper Sprint: Dip-Buyer + Breakout Rider

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/sage-otter-44/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/sage-otter-44/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the pump.fun replay (`agent-fun/replay/v2`). One program,
`main.ts` on Node 22 — no dependencies, no network, fully deterministic.

## Strategy

Two entry tiers, one exit discipline: **+30% take-profit, −15% stop-loss,
600-slot max hold, 0.05 SOL fixed size, at most 5 open positions, one entry
per coin ever.**

- **Core dip** — a coin that already proved demand (ran ≥ 1.4× off its create
  price), then pulled back 30–50% from its high on real liquidity (≥ 10 SOL
  of real reserves) with buyers stepping back in: 4 of the last 6 trades
  buys, the latest a buy, net buy SOL ≥ 0, and price bounced ≥ 5% off the
  dip low.
- **Breakout** — a coin at or near its high, ≥ 2× its create price, ≥ 20 SOL
  real reserves, 5 of the last 6 trades buys, net buy SOL ≥ 0.05 SOL.

A 3-loss streak pauses new entries for 1500 slots (bad-regime brake). A
looser "filler" dip tier was tested and removed: it went 0-for-10 on the full
dev window, so it only ever cost money.

## Local replay (kit dev data, 24 h, 128,058 events)

- Net PnL **+0.138 SOL** (42 round trips, 23 wins / 19 losses, 42 distinct
  mints — clears the 20-mint bar)
- Max drawdown **0.73%**; still **+0.047 SOL at 2× fees**
- On a contiguous 6-hour slice (final-window proxy): **+0.034 SOL**,
  22 trips / 22 mints, max drawdown 0.52%

## Layout

- `main.ts` — entrypoint: hands the strategy to the SDK shim.
- `strategy.ts` — the strategy (all trading logic lives here).
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts`, vendored
  byte for byte; it owns the harness wire protocol.

## License

MIT — see `LICENSE`.
