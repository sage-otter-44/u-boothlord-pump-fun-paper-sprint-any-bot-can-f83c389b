// Dip-buyer + breakout rider for the pump.fun replay (agent-fun/replay/v2).
//
// Two entry tiers, one exit discipline (+30% take-profit, -15% stop-loss,
// 600-slot max hold, 0.05 SOL fixed size, at most 5 open positions):
//   CORE DIP — a coin that already proved demand (ran >= 1.4x off its create
//     price), then pulled back 30-50% from its high on real liquidity
//     (>= 10 SOL of real reserves) with buyers stepping back in (4 of the
//     last 6 trades buys, latest a buy, net buy SOL >= 0, bounced >= 5% off
//     the dip low).
//   BREAKOUT — a coin at/near its high, >= 2x its create price, >= 20 SOL
//     real reserves, 5 of the last 6 trades buys, net buy SOL >= 0.05.
// A 3-loss streak pauses entries for 1500 slots (bad-regime brake).
// The filler tier (looser dips at half size) was tested and REMOVED: it went
// 0-for-10 on the full dev window, so it only ever cost money.
// Fully deterministic: every decision comes from the harness state only.
// No clock, no randomness, no environment.

import type { Batch, Bot, BotState } from './vendor/makefun-bot.ts';

export interface DipParams {
  mode: 'dip' | 'momentum';
  /** SOL spent per buy (fixed). */
  sizeSol: number;
  maxOpen: number;
  maxEntries: number;
  /** Minimum trades seen on the coin before it can be entered. */
  minTrades: number;
  /** Dip mode: the coin's high must reach this multiple of its create price. */
  minHighMult: number;
  /** Dip mode: enter only when price <= this share of the high (retraced). */
  maxRetrace: number;
  /** Dip mode: skip coins that fell below this share of the high (freefall). */
  minRetrace: number;
  /** Minimum real SOL reserves at entry. */
  minRealSol: number;
  /** Of the last 6 trades, at least this many must be buys. */
  recentBuys: number;
  /** The latest trade must be a buy. */
  requireLastBuy: boolean;
  /** Dip mode: price must have bounced at least this multiple off the dip low. */
  minBounce: number;
  /** Dip mode: net buy SOL in the last 6 trades must exceed net sell SOL by this. */
  minNetBuySol: number;
  /** Momentum mode: enter only when price >= this multiple of create price. */
  minMomentumMult: number;
  /** Sell when mark / cost-basis reaches this. */
  takeProfit: number;
  /** Sell when mark / cost-basis falls to this. */
  stopLoss: number;
  /** Within this many slots of entry, sell if mark / cost-basis falls to earlyDecayRatio. */
  earlyDecaySlots: number;
  earlyDecayRatio: number;
  /** Sell after this many slots held, whatever the price. */
  maxHoldSlots: number;
  /** Max buys placed in a single batch (up to the open-position cap). */
  maxBuysPerBatch: number;
  /** After this many losing round trips in a row, pause entries for cooloffSlots. 0 disables. */
  cooloffLosses: number;
  cooloffSlots: number;
  /** Filler tier: looser dip entries at a smaller size, only to clear the 20-mint bar. */
  fillerSizeSol: number;
  fillerMaxEntries: number;
  fillerMinTrades: number;
  fillerMinHighMult: number;
  fillerMaxRetrace: number;
  fillerMinRealSol: number;
  fillerRecentBuys: number;
  /** Breakout tier: coins making new highs on heavy buying. */
  breakoutSizeSol: number;
  breakoutMaxEntries: number;
  breakoutMinMult: number;
  breakoutMinRealSol: number;
  breakoutRecentBuys: number;
  breakoutMaxTrades: number;
  breakoutMinNetBuySol: number;
  breakoutTakeProfit: number;
  breakoutStopLoss: number;
  breakoutMaxHoldSlots: number;
  maxSlippageBps: number;
}

export const DEFAULT_PARAMS: DipParams = {
  mode: 'dip',
  sizeSol: 0.05,
  maxOpen: 5,
  maxEntries: 45,
  minTrades: 8,
  minHighMult: 1.4,
  maxRetrace: 0.7,
  minRetrace: 0.5,
  minRealSol: 10,
  recentBuys: 4,
  requireLastBuy: true,
  minBounce: 1.05,
  minNetBuySol: 0,
  minMomentumMult: 1.25,
  takeProfit: 1.3,
  stopLoss: 0.85,
  earlyDecaySlots: 0,
  earlyDecayRatio: 0.9,
  maxHoldSlots: 600,
  maxBuysPerBatch: 1,
  cooloffLosses: 3,
  cooloffSlots: 1500,
  fillerSizeSol: 0.025,
  fillerMaxEntries: 0,
  fillerMinTrades: 6,
  fillerMinHighMult: 1.3,
  fillerMaxRetrace: 0.8,
  fillerMinRealSol: 8,
  fillerRecentBuys: 3,
  breakoutSizeSol: 0.05,
  breakoutMaxEntries: 10,
  breakoutMinMult: 2.0,
  breakoutMinRealSol: 20,
  breakoutRecentBuys: 5,
  breakoutMaxTrades: 100,
  breakoutMinNetBuySol: 0.05,
  breakoutTakeProfit: 1.3,
  breakoutStopLoss: 0.85,
  breakoutMaxHoldSlots: 600,
  maxSlippageBps: 500,
};

interface CoinTrack {
  mint: string;
  /** First-seen order (insertion order of `coins`); the entry scan order. */
  seq: number;
  createPrice: number;
  createdSlot: number;
  high: number;
  /** Lowest price since the high was set. */
  dipLow: number;
  trades: number;
  /** Last 6 trade directions, true = buy. */
  recent: boolean[];
  /** SOL amounts of the last 6 trades (positive = buy, negative = sell). */
  recentSol: number[];
  lastBuy: boolean;
  lastPrice: number;
  lastRealSol: number;
  /**
   * Cached local entry verdict, recomputed on every touch of this coin.
   * Exact: a coin's local entry state changes only on its own Create/Trade
   * events (marks cover held/pending mints only, and those are `entered`,
   * so they can never be entered again), so the cache is never stale.
   */
  local: { tier: 'core' | 'filler' | 'breakout'; sizeSol: number } | null;
}

interface Held {
  entrySlot: number;
  costPerToken: number;
  tier: 'core' | 'filler' | 'breakout';
}

const LAMPORTS_PER_SOL = 1_000_000_000n;

export function createStrategy(p: DipParams): Bot {
  const coins = new Map<string, CoinTrack>();
  const entered = new Set<string>();
  const held = new Map<string, Held>();
  const selling = new Set<string>();
  const pendingTier = new Map<string, 'core' | 'filler' | 'breakout'>();
  let entries = 0;
  let fillerEntries = 0;
  let breakoutEntries = 0;
  let lossStreak = 0;
  let cooloffUntil = -1;
  let nextSeq = 0;
  /**
   * Coins whose cached local verdict is non-null, kept sorted by first-seen
   * order (seq). The entry scan walks this list instead of the whole `coins`
   * map: a coin outside it fails a local test, so the old scan would have
   * skipped it too — same first qualifying coin, same orders. This is the
   * whole speed fix: the old scan re-ran entryOk (reduces, BigInt math, a
   * fresh Set allocation per coin in committedPositionCount) over ~1,200
   * coins on every one of ~63k batches.
   */
  const candidates: CoinTrack[] = [];

  function candIndex(seq: number): number {
    let lo = 0;
    let hi = candidates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[mid]!.seq < seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function candAdd(t: CoinTrack): void {
    const i = candIndex(t.seq);
    if (candidates[i] !== t) candidates.splice(i, 0, t);
  }

  function candRemove(t: CoinTrack): void {
    const i = candIndex(t.seq);
    if (candidates[i] === t) candidates.splice(i, 1);
  }

  function newTrack(mint: string, price: number, slot: number): CoinTrack {
    return {
      mint,
      seq: nextSeq++,
      createPrice: price,
      createdSlot: slot,
      high: price,
      dipLow: price,
      trades: 0,
      recent: [],
      recentSol: [],
      lastBuy: false,
      lastPrice: price,
      lastRealSol: 0,
      local: null,
    };
  }

  /**
   * The coin-local half of entryOk, verbatim: every test that depends only
   * on this coin's own track state and its own curve (maxBuyLamports reads
   * this mint's real reserves, which move only on its own trades).
   */
  function localEntry(
    state: BotState,
    mint: string,
    t: CoinTrack,
  ): { tier: 'core' | 'filler' | 'breakout'; sizeSol: number } | null {
    if (t.trades < p.minTrades) return null;
    const buys = t.recent.reduce((n, b) => n + (b ? 1 : 0), 0);
    const netBuySol = t.recentSol.reduce((n, s) => n + s, 0);
    if (p.requireLastBuy && !t.lastBuy) return null;
    // Breakout tier: fresh highs on heavy buying, real money behind it.
    if (
      breakoutEntries < p.breakoutMaxEntries &&
      t.trades <= p.breakoutMaxTrades &&
      t.lastPrice >= p.breakoutMinMult * t.createPrice &&
      t.lastPrice >= 0.95 * t.high &&
      t.lastRealSol >= p.breakoutMinRealSol &&
      buys >= p.breakoutRecentBuys &&
      netBuySol >= p.breakoutMinNetBuySol &&
      state.maxBuyLamports(mint) >= BigInt(Math.round(p.breakoutSizeSol * 1e9))
    ) {
      return { tier: 'breakout', sizeSol: p.breakoutSizeSol };
    }
    // Core dip tier: proven pumper, deep retrace, buyers stepping back in.
    if (t.lastRealSol >= p.minRealSol && buys >= p.recentBuys && netBuySol >= p.minNetBuySol) {
      if (p.mode === 'dip') {
        if (
          t.high >= p.minHighMult * t.createPrice &&
          t.lastPrice <= p.maxRetrace * t.high &&
          t.lastPrice >= p.minRetrace * t.high &&
          t.lastPrice >= p.minBounce * t.dipLow &&
          state.maxBuyLamports(mint) >= BigInt(Math.round(p.sizeSol * 1e9))
        ) {
          return { tier: 'core', sizeSol: p.sizeSol };
        }
      } else {
        if (
          t.lastPrice >= p.minMomentumMult * t.createPrice &&
          t.lastPrice >= 0.9 * t.high &&
          state.maxBuyLamports(mint) >= BigInt(Math.round(p.sizeSol * 1e9))
        ) {
          return { tier: 'core', sizeSol: p.sizeSol };
        }
      }
    }
    // Filler dip tier: looser dip at half size, only to clear the 20-mint bar.
    if (
      fillerEntries < p.fillerMaxEntries &&
      t.trades >= p.fillerMinTrades &&
      t.high >= p.fillerMinHighMult * t.createPrice &&
      t.lastPrice <= p.fillerMaxRetrace * t.high &&
      t.lastPrice >= p.minRetrace * t.high &&
      t.lastRealSol >= p.fillerMinRealSol &&
      buys >= p.fillerRecentBuys &&
      netBuySol >= 0 &&
      state.maxBuyLamports(mint) >= BigInt(Math.round(p.fillerSizeSol * 1e9))
    ) {
      return { tier: 'filler', sizeSol: p.fillerSizeSol };
    }
    return null;
  }

  /** Recompute one coin's cached local verdict after a touch; entered coins can never re-enter. */
  function refreshLocal(state: BotState, mint: string, t: CoinTrack): void {
    if (entered.has(mint)) {
      t.local = null;
      candRemove(t);
      return;
    }
    const v = localEntry(state, mint, t);
    t.local = v;
    if (v !== null) candAdd(t);
    else candRemove(t);
  }

  function priceOf(state: BotState, mint: string): number | null {
    const c = state.curves.get(mint);
    if (!c || c.virtual_token_reserves === 0n) return null;
    return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
  }

  function track(state: BotState, batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        const t = newTrack(e.mint, price, e.slot);
        coins.set(e.mint, t);
        refreshLocal(state, e.mint, t);
      } else if (e.event === 'TradeEvent') {
        let t = coins.get(e.mint);
        if (!t) {
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t = newTrack(e.mint, price, e.slot);
          coins.set(e.mint, t);
        }
        const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        t.trades += 1;
        t.recent.push(e.is_buy);
        if (t.recent.length > 6) t.recent.shift();
        t.recentSol.push((e.is_buy ? 1 : -1) * Number(e.sol_amount) / 1e9);
        if (t.recentSol.length > 6) t.recentSol.shift();
        t.lastBuy = e.is_buy;
        t.lastPrice = price;
        t.lastRealSol = Number(e.real_quote_reserves) / 1e9;
        if (price > t.high) {
          t.high = price;
          t.dipLow = price;
        } else if (price < t.dipLow) {
          t.dipLow = price;
        }
        refreshLocal(state, e.mint, t);
      } else if (e.event === 'CompleteEvent') {
        const t = coins.get(e.mint);
        if (t !== undefined) candRemove(t);
        coins.delete(e.mint);
        held.delete(e.mint);
      }
    }
  }

  function foldFills(state: BotState, batch: Batch): void {
    for (const f of batch.fills) {
      if (f.side === 'sell') {
        selling.delete(f.mint);
        const h = held.get(f.mint);
        if (f.status === 'filled' && h) {
          const tokens = BigInt(f.token_amount);
          const proceeds = BigInt(f.quote_lamports);
          const cost = BigInt(Math.round(h.costPerToken * Number(tokens)));
          if (proceeds < cost) {
            lossStreak += 1;
            if (p.cooloffLosses > 0 && lossStreak >= p.cooloffLosses) {
              cooloffUntil = batch.slot + p.cooloffSlots;
              lossStreak = 0;
            }
          } else {
            lossStreak = 0;
          }
        }
      }
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        const tokens = BigInt(f.token_amount);
        const quote = BigInt(f.quote_lamports);
        if (tokens > 0n) {
          held.set(f.mint, {
            entrySlot: f.slot,
            costPerToken: Number(quote) / Number(tokens),
            tier: pendingTier.get(f.client_id) ?? 'core',
          });
        }
        pendingTier.delete(f.client_id);
      } else {
        held.delete(f.mint);
      }
    }
    // Positions closed by the harness (complete / flatten) vanish from the account.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) {
        held.delete(mint);
        selling.delete(mint);
      }
    }
  }

  /**
   * Fresh local verdict for a candidate. The cached verdict is exact except
   * for one input: the tier counters (breakoutEntries / fillerEntries), which
   * move when another coin is placed. A cached breakout/filler verdict whose
   * tier has since hit its cap is recomputed here, so the coin falls through
   * to the dip branch exactly as the uncached test would.
   */
  function localNow(
    state: BotState,
    mint: string,
    t: CoinTrack,
  ): { tier: 'core' | 'filler' | 'breakout'; sizeSol: number } | null {
    const v = t.local;
    if (v === null) return null;
    if (v.tier === 'breakout' && breakoutEntries >= p.breakoutMaxEntries) {
      const fresh = localEntry(state, mint, t);
      t.local = fresh;
      return fresh;
    }
    if (v.tier === 'filler' && fillerEntries >= p.fillerMaxEntries) {
      const fresh = localEntry(state, mint, t);
      t.local = fresh;
      return fresh;
    }
    return v;
  }

  /**
   * Global half of the entry test. The globals in `g` are computed once per
   * batch: nothing in onBatch mutates state.pending, state.positions or cash
   * (recordOrders runs after onBatch returns), so they are constant across
   * the scan — hoisting them out of the per-coin test changes nothing.
   * The coin-local half is the cached `t.local`, refreshed via localNow.
   */
  function entryOk(
    state: BotState,
    mint: string,
    t: CoinTrack,
    g: { committed: number; freeCash: bigint; pendingBuys: Set<string> },
  ): { tier: 'core' | 'filler' | 'breakout'; sizeSol: number } | null {
    if (entered.has(mint)) return null;
    if (entries >= p.maxEntries) return null;
    if (g.committed >= p.maxOpen) return null;
    if (g.pendingBuys.has(mint)) return null;
    // Never place a buy the account cannot fund (size + tx fee), so a buy
    // order is never wasted on an insufficient-cash rejection.
    if (g.freeCash < BigInt(Math.round(p.sizeSol * 1e9)) + state.txFeeLamports()) return null;
    return localNow(state, mint, t);
  }

  return {
    onBatch(state: BotState, batch: Batch) {
      track(state, batch);
      foldFills(state, batch);
      const orders: { side: 'buy' | 'sell'; client_id?: string; mint: string; quote_lamports?: bigint; token_amount?: bigint; max_slippage_bps: number }[] = [];

      // Exits first: take profit, stop loss, early decay cut, max hold.
      // Breakout entries ride momentum longer with a wider target.
      for (const [mint, pos] of state.positions) {
        const h = held.get(mint);
        if (!h) continue;
        if (selling.has(mint)) continue;
        const price = priceOf(state, mint);
        if (price === null || h.costPerToken <= 0) continue;
        const ratio = price / h.costPerToken;
        const age = batch.slot - h.entrySlot;
        const tp = h.tier === 'breakout' ? p.breakoutTakeProfit : p.takeProfit;
        const sl = h.tier === 'breakout' ? p.breakoutStopLoss : p.stopLoss;
        const hold = h.tier === 'breakout' ? p.breakoutMaxHoldSlots : p.maxHoldSlots;
        const exit =
          ratio >= tp ||
          ratio <= sl ||
          (h.tier !== 'breakout' && age <= p.earlyDecaySlots && ratio <= p.earlyDecayRatio) ||
          age >= hold;
        if (exit) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: pos.token_amount,
            max_slippage_bps: p.maxSlippageBps,
          });
          selling.add(mint);
        }
      }

      // Entries: scan the candidate list (local-ok coins, first-seen order);
      // up to maxBuysPerBatch per batch. Same first qualifying coin as
      // scanning every tracked coin: any coin outside the list fails a local
      // test, and the globals are identical for every coin in the batch.
      if (batch.slot >= cooloffUntil && entries < p.maxEntries && state.committedPositionCount() < p.maxOpen) {
        const g = {
          committed: state.committedPositionCount(),
          freeCash: state.freeCashLamports(),
          pendingBuys: new Set(
            [...state.pending.values()]
              .filter((pend) => pend.order.side === 'buy')
              .map((pend) => pend.order.mint),
          ),
        };
        let placed = 0;
        for (let ci = 0; ci < candidates.length; ci++) {
          if (placed >= p.maxBuysPerBatch) break;
          if (g.committed >= p.maxOpen) break;
          const t = candidates[ci]!;
          const mint = t.mint;
          const ok = entryOk(state, mint, t, g);
          if (ok === null) {
            // Fresh local verdict is null (localNow cleared the stale cache):
            // this coin cannot qualify until it is touched again.
            if (t.local === null) {
              candidates.splice(ci, 1);
              ci--;
            }
            continue;
          }
          const cid = `${ok.tier === 'breakout' ? 'brk' : ok.tier === 'filler' ? 'fil' : 'cor'}${entries}`;
          orders.push({
            side: 'buy',
            client_id: cid,
            mint,
            quote_lamports: BigInt(Math.round(ok.sizeSol * 1e9)),
            max_slippage_bps: p.maxSlippageBps,
          });
          pendingTier.set(cid, ok.tier);
          entered.add(mint);
          entries += 1;
          if (ok.tier === 'filler') fillerEntries += 1;
          if (ok.tier === 'breakout') breakoutEntries += 1;
          placed += 1;
        }
      }

      return orders as never;
    },
  };
}
