import { CLOB_BASE, bestBidAsk, fetchJson, fmtCents, marketFill, sleep } from './utils.js';
import { appendTradeLog, readState, writeClosedSummary, writeState } from './state.js';
import { buildPosition, defaultConfig, findOpportunity, shouldExit } from './engine.js';

function parseArgs(argv) {
  const cfg = defaultConfig();
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    const next = v ?? argv[i + 1];
    const read = () => (v ? v : (i++, next));

    if (k === 'notional') cfg.notional = Number(read());
    if (k === 'minMove') cfg.minMove = Number(read());
    if (k === 'maxSpread') cfg.maxSpread = Number(read());
    if (k === 'pollMs') cfg.pollMs = Number(read());
    if (k === 'minVolume24h') cfg.minVolume24h = Number(read());
    if (k === 'minLiquidity') cfg.minLiquidity = Number(read());
  }
  return cfg;
}

async function markAndSnapshot(state, tokenId, mid, bid, ask) {
  state.snapshots.byToken[tokenId] = { mid, bid, ask, t: Date.now() };
  state.snapshots.t = Date.now();
}

async function run() {
  const cfg = parseArgs(process.argv);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const state = await readState();

    if (!state.openPosition) {
      const res = await findOpportunity(state, cfg);

      // Update snapshots even if we don't enter (so moves are meaningful).
      for (const u of res.snapshotUpdates ?? []) {
        state.snapshots.byToken[u.tokenId] = { mid: u.mid, bid: u.bid, ask: u.ask, t: Date.now() };
      }
      state.snapshots.t = Date.now();
      state.lastScanAt = Date.now();
      await writeState(state);

      if (!res.best) {
        await sleep(cfg.pollMs);
        continue;
      }

      const position = buildPosition(res.best, cfg);
      state.openPosition = position;

      await appendTradeLog(position.id, {
        t: Date.now(),
        type: 'OPEN',
        marketId: position.marketId,
        tokenId: position.tokenId,
        question: position.question,
        url: position.url,
        notional: position.notional,
        entry: position.entry,
        exits: position.exits,
      });

      await markAndSnapshot(state, position.tokenId, position.lastMark.mid, position.lastMark.bid, position.lastMark.ask);
      await writeState(state);

      // Next loop tick will monitor.
      await sleep(cfg.pollMs);
      continue;
    }

    // Monitor open position
    const p = state.openPosition;

    let book;
    try {
      book = await fetchJson(`${CLOB_BASE}/book?token_id=${p.tokenId}`);
    } catch {
      await sleep(cfg.pollMs);
      continue;
    }

    const { bestBid, bestAsk } = bestBidAsk(book);
    if (bestBid == null || bestAsk == null) {
      await sleep(cfg.pollMs);
      continue;
    }

    const mid = (bestBid + bestAsk) / 2;

    p.lastMark = { t: Date.now(), mid, bid: bestBid, ask: bestAsk };
    await appendTradeLog(p.id, {
      t: Date.now(),
      type: 'MARK',
      bid: bestBid,
      ask: bestAsk,
      mid,
    });

    await markAndSnapshot(state, p.tokenId, mid, bestBid, bestAsk);

    const exitDecision = shouldExit(p, { bid: bestBid, ask: bestAsk, mid });
    if (!exitDecision) {
      await writeState(state);
      await sleep(cfg.pollMs);
      continue;
    }

    // Exit (market-like sell): consume bids for shares. Convert shares->notional via marketFill.
    const exitFill = marketFill(book, 'sell', Math.min(p.notional, p.entry.avgPrice * p.entry.shares));
    // If we can't compute sell fill by notional, approximate by selling the same notional.
    const exitAvg = exitFill?.avgPrice ?? bestBid;

    const pnlPerShare = exitAvg - p.entry.avgPrice;
    const pnl = pnlPerShare * p.entry.shares;

    const closed = {
      id: p.id,
      openedAt: p.openedAt,
      closedAt: Date.now(),
      durationMs: Date.now() - p.openedAt,
      marketId: p.marketId,
      question: p.question,
      url: p.url,
      tokenId: p.tokenId,
      notional: p.notional,
      entryAvg: p.entry.avgPrice,
      exitAvg,
      shares: p.entry.shares,
      pnl,
      pnlCents: Number((pnl * 100).toFixed(2)),
      exitReason: exitDecision.reason,
      exits: p.exits,
      lastMark: p.lastMark,
    };

    await appendTradeLog(p.id, {
      t: Date.now(),
      type: 'CLOSE',
      exitReason: exitDecision.reason,
      exitAvg,
      pnl,
    });

    await writeClosedSummary(p.id, closed);

    // clear open position
    state.lastClosedId = p.id;
    state.openPosition = null;
    await writeState(state);

    // Print a concise line to stdout (useful if running under a process manager)
    console.log(
      `[CLOSED] ${closed.question} | entry ${fmtCents(closed.entryAvg)} -> exit ${fmtCents(closed.exitAvg)} | PnL $${closed.pnl.toFixed(2)} | ${closed.exitReason}`
    );

    await sleep(cfg.pollMs);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
