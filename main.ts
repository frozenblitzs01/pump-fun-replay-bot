// Frozen momentum bot — Pump.fun Replay Sprint (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts
// and the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for
// byte in vendor/. Paper money only: 10 SOL starting cash, at most 5 open
// positions, no wallet, no network, no API key.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// Guard: keep the paper budget inside the harness caps — the strategy
// itself never spends more than free cash or the per-coin size cap, and
// runBot enforces the per-batch order cap before any reply is sent.
await runBot(createStrategy({ ...DEFAULT_PARAMS, maxMain: 5 }));
