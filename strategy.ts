// Frozen momentum bot for the pump.fun replay (agent-fun/replay/v2).
//
// Strategy, in one paragraph: watch every new bonding curve's tape of
// recorded trades; buy a small first stake when the tape shows real,
// accelerating buy pressure (net SOL flowing in, several distinct buyers,
// price up and sitting near its window high) on a curve that is old enough
// to have survived its launch dump and liquid enough to trade; pyramid a
// little into strength up to a fixed stake per coin; exit the whole position
// on a stop-loss, a trailing stop once it has run up, a take-profit, or a
// time limit. A pacing probe keeps the run above the guardrail of 20 coins
// with a real round trip each: when coins traded lag the elapsed share of
// the 24h window, buy a tiny probe of the most liquid fresh curve and sell
// it as soon as the buy lands.
//
// Deterministic: no clock, no environment, no Math.random; iteration only
// over insertion-ordered maps fed by the batch stream. All money is paper:
// the harness starts the bot with 10 SOL of paper cash, at most 5 open
// positions, and every order respects the harness size caps and the paper
// budget (never more cash than freeCashLamports allows).

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry lookback, in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window needed to enter. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at window start, minus 1. */
  minPriceUp: number;
  /** Price now at least this share of the window high. */
  nearHigh: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Total SOL to put into one position. */
  stakeSol: number;
  /** First buy of a position, in SOL. */
  initialSol: number;
  /** Each pyramid add-on buy, in SOL. */
  addSol: number;
  /** Slippage allowed on buys (bps); sells always go out wide open. */
  buySlipBps: number;
  /** Sell when close value falls this far below cost. */
  stopLoss: number;
  /** Sell when close value falls this far below its peak (once armed). */
  trail: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Sell when close value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /** Guardrail pacing: target distinct coins and fills over paceSecs. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Probe buy size, in SOL. */
  probeSol: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 40,
  minNetSol: 1.5,
  minBuys: 5,
  minBuyers: 5,
  minPriceUp: 0.1,
  nearHigh: 0.97,
  minRqSol: 1,
  maxRqSol: 80,
  minAge: 2000,
  stakeSol: 0.2,
  initialSol: 0.05,
  addSol: 0.05,
  buySlipBps: 1500,
  stopLoss: 0.25,
  trail: 0.15,
  trailArm: 0.1,
  takeProfit: 0.6,
  maxHold: 2000,
  cooldown: 150,
  maxEntries: 2,
  maxMain: 5,
  targetCoins: 25,
  targetFills: 100,
  paceSecs: 86400,
  probeSol: 0.02,
};

const LAMPORTS = 1e9;
/** Curve + tx fees on a sell, as a share of the quote out. */
const SELL_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  lastAddPrice: number;
  exiting: boolean;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

/** Net SOL proceeds of selling `tokens` at current reserves, fees deducted. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint, txFeeSol: number): number {
  const t = Number(tokens);
  if (t <= 0 || vt === 0n) return 0;
  const q = (t * Number(vq)) / (Number(vt) + t);
  return Math.max(0, q * (1 - SELL_FEE) - txFeeSol);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, boolean>(); // false = buying, true = selling
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    if (t.entries >= p.maxEntries) return false;
    if (now - t.lastExit < p.cooldown) return false;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    if (netNew <= 0 || netNew < netOld) return false; // accelerating inflow
    if (startPrice <= 0 || last <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const { caps } = state.hello;
      const txFeeSol = Number(state.txFeeLamports()) / LAMPORTS;
      const orders: OrderInput[] = [];

      // Fold this batch's events into the tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(BigInt(e.sol_amount)) / LAMPORTS,
            user: e.user,
            price,
          });
          if (e.timestamp !== null) {
            const ts = Number(e.timestamp);
            if (firstTime === null) firstTime = ts;
            lastTime = ts;
          }
        } else if (e.event === 'CompleteEvent') {
          tapes.delete(e.mint);
        }
      }
      // Prune old trades so tapes stay bounded.
      const keepFrom = batch.slot - Math.max(p.window, p.maxHold) - 100;
      for (const t of tapes.values()) {
        while (t.trades.length > 0 && t.trades[0].slot < keepFrom) t.trades.shift();
      }

      // Count our own fills (harness closes excluded by client_id prefix).
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
          if (f.side === 'buy' && probes.get(f.mint) === false) probes.set(f.mint, true);
          if (f.side === 'sell') probes.delete(f.mint);
        }
        if (f.status === 'filled' && f.side === 'sell' && held.has(f.mint)) {
          const h = held.get(f.mint)!;
          if (state.positions.get(f.mint) === undefined) {
            held.delete(f.mint);
            tapeOf(f.mint).lastExit = batch.slot;
          }
        }
      }

      let free = state.freeCashLamports();
      const tx = state.txFeeLamports();

      // 1) Exits first: stop-loss, trailing stop, take-profit, time limit.
      for (const [mint, pos] of state.positions) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (probes.has(mint)) continue;
        const h = held.get(mint);
        if (h === undefined || h.exiting) continue;
        const value = sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves, txFeeSol);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (cost <= 0) continue;
        if (value > h.peakValue) h.peakValue = value;
        const up = value / cost - 1;
        const armed = h.peakValue >= cost * (1 + p.trailArm);
        const timeUp = batch.slot - h.opened >= p.maxHold;
        if (
          up <= -p.stopLoss ||
          (armed && value <= h.peakValue * (1 - p.trail)) ||
          up >= p.takeProfit ||
          timeUp
        ) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
          h.exiting = true;
        }
      }

      // 2) Pyramid into strength: add while price is at/above the last buy
      //    and the entry signal still holds, up to the per-coin stake.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= caps.max_orders_per_batch) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (probes.has(mint)) continue;
        const h = held.get(mint);
        if (h === undefined || h.exiting) continue;
        const invested = Number(pos.cost_lamports) / LAMPORTS;
        if (invested >= p.stakeSol - 1e-9) continue;
        const t = tapes.get(mint);
        if (t === undefined) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price < h.lastAddPrice) continue;
        if (!entrySignal(t, batch.slot, rqSol)) continue;
        const cap = state.maxBuyLamports(mint);
        const amount = BigInt(Math.floor(Math.min(p.addSol, p.stakeSol - invested) * LAMPORTS));
        if (amount <= 0n || cap < amount || free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        h.lastAddPrice = price;
      }

      // 3) Fresh momentum entries, in batch event order.
      let slots = caps.max_open_positions - state.committedPositionCount();
      for (const e of batch.events) {
        if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
        if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
        const mint = e.mint;
        if (state.positions.has(mint) || probes.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tapes.get(mint);
        if (t === undefined) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, batch.slot, rqSol)) continue;
        // Only one momentum position per batch-order slot budget counts;
        // skip if another buy for this mint is already queued this batch.
        if (orders.some((o) => o.mint === mint)) continue;
        const cap = state.maxBuyLamports(mint);
        const amount = BigInt(Math.floor(p.initialSol * LAMPORTS));
        if (cap < amount || free < amount + tx) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        slots -= 1;
        t.entries += 1;
        held.set(mint, {
          opened: batch.slot,
          peakValue: 0,
          invested: p.initialSol,
          lastAddPrice: price,
          exiting: false,
        });
      }

      // 4) Guardrail pacing probe: if coins/fills lag the elapsed share of
      //    the window, buy a tiny probe of the most liquid fresh curve and
      //    sell it as soon as the buy lands (handled in the fills loop).
      if (firstTime !== null && lastTime !== null && lastTime > firstTime) {
        const elapsed = lastTime - firstTime;
        const pace = Math.min(1, elapsed / p.paceSecs);
        const coinsBehind = myCoins.size < Math.ceil(p.targetCoins * pace);
        const fillsBehind = myFills < Math.ceil(p.targetFills * pace);
        if ((coinsBehind || fillsBehind) && slots > 0 && orders.length < caps.max_orders_per_batch) {
          let best: Pubkey | null = null;
          let bestRq = 0;
          for (const [mint, curve] of state.curves) {
            if (curve.complete || state.positions.has(mint) || probes.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
            if (rqSol < 5) continue;
            if (rqSol > bestRq) {
              bestRq = rqSol;
              best = mint;
            }
          }
          if (best !== null) {
            const amount = BigInt(Math.floor(p.probeSol * LAMPORTS));
            const cap = state.maxBuyLamports(best);
            if (cap >= amount && free >= amount + tx) {
              orders.push({ side: 'buy', mint: best, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
              probes.set(best, false);
              free -= amount + tx;
            }
          }
        }
      }

      // 5) Sell probes whose buy has landed.
      for (const [mint, selling] of probes) {
        if (!selling) continue;
        if (orders.length >= caps.max_orders_per_batch) break;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (orders.some((o) => o.mint === mint)) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
      }

      return orders;
    },
  };
}
