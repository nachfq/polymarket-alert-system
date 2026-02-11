import { CLOB_BASE, GAMMA_BASE, bestBidAsk, fetchJson, fmtCents, marketFill, safeParseJsonArray } from './utils.js';

export function defaultConfig() {
  return {
    notional: 200,
    scanLimit: 200,
    minVolume24h: 50_000,
    minLiquidity: 10_000,
    maxSpread: 0.02, // 2c
    minMove: 0.02, // 2c since last scan snapshot
    tp: 0.02, // +2c
    sl: 0.02, // -2c
    maxHoldMs: 60 * 60_000, // 60min
    pollMs: 30_000,
  };
}

function pickTokenByMove(tokens) {
  // tokens: [{tokenId, mid, prevMid, spread, book, directionHint}]
  // Pick the one with the largest absolute move and sane spread.
  const sorted = [...tokens].sort((a, b) => Math.abs(b.mid - b.prevMid) - Math.abs(a.mid - a.prevMid));
  return sorted[0] ?? null;
}

export async function findOpportunity(state, cfg) {
  const markets = await fetchJson(
    `${GAMMA_BASE}/markets?closed=false&limit=${cfg.scanLimit}&order=volume24hr&ascending=false`
  );

  const snapshotUpdates = [];

  const candidates = markets
    .filter((m) => m && m.closed === false)
    .filter((m) => m.enableOrderBook)
    .filter((m) => m.acceptingOrders !== false)
    .filter((m) => Number(m.volume24hr ?? 0) >= cfg.minVolume24h)
    .filter((m) => Number(m.liquidityNum ?? m.liquidity ?? 0) >= cfg.minLiquidity)
    .filter((m) => {
      const outs = safeParseJsonArray(m.outcomes);
      return outs.length === 2; // MVP: binary only
    })
    .slice(0, 40);

  const scored = [];

  for (const m of candidates) {
    const tokenIds = safeParseJsonArray(m.clobTokenIds);
    if (tokenIds.length < 2) continue;

    // For binary markets we can treat token[0] and token[1] as complementary.
    const tokenA = String(tokenIds[0]);
    const tokenB = String(tokenIds[1]);

    let bookA, bookB;
    try {
      [bookA, bookB] = await Promise.all([
        fetchJson(`${CLOB_BASE}/book?token_id=${tokenA}`),
        fetchJson(`${CLOB_BASE}/book?token_id=${tokenB}`),
      ]);
    } catch {
      continue;
    }

    const { bestBid: bidA, bestAsk: askA } = bestBidAsk(bookA);
    const { bestBid: bidB, bestAsk: askB } = bestBidAsk(bookB);

    if (bidA == null || askA == null || bidB == null || askB == null) continue;

    const midA = (bidA + askA) / 2;
    const midB = (bidB + askB) / 2;

    snapshotUpdates.push({ tokenId: tokenA, mid: midA, bid: bidA, ask: askA });
    snapshotUpdates.push({ tokenId: tokenB, mid: midB, bid: bidB, ask: askB });

    const spreadA = askA - bidA;
    const spreadB = askB - bidB;

    if (spreadA > cfg.maxSpread && spreadB > cfg.maxSpread) continue;

    const prevA = state.snapshots.byToken?.[tokenA]?.mid ?? midA;
    const prevB = state.snapshots.byToken?.[tokenB]?.mid ?? midB;

    const moveA = midA - prevA;
    const moveB = midB - prevB;

    const best = pickTokenByMove([
      { tokenId: tokenA, mid: midA, prevMid: prevA, spread: spreadA, book: bookA, move: moveA },
      { tokenId: tokenB, mid: midB, prevMid: prevB, spread: spreadB, book: bookB, move: moveB },
    ]);

    if (!best) continue;
    const absMove = Math.abs(best.mid - best.prevMid);
    if (absMove < cfg.minMove) continue;
    if (best.spread > cfg.maxSpread) continue;

    // Can we enter with a market-like fill?
    const entry = marketFill(best.book, 'buy', cfg.notional);
    if (!entry) continue;

    // Basic score: prefer tighter spread and bigger move and higher vol/liquidity.
    const score =
      (absMove / 0.05) * 50 +
      (1 - Math.min(1, best.spread / cfg.maxSpread)) * 20 +
      Math.min(20, Math.log10(1 + Number(m.volume24hr ?? 0)) * 3);

    scored.push({
      score,
      market: m,
      chosen: {
        tokenId: best.tokenId,
        mid: best.mid,
        prevMid: best.prevMid,
        move: best.mid - best.prevMid,
        spread: best.spread,
        bid: best.tokenId === tokenA ? bidA : bidB,
        ask: best.tokenId === tokenA ? askA : askB,
        entry,
      },
      url: `https://polymarket.com/market/${m.slug}`,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0] ?? null;

  if (!top) return { best: null, snapshotUpdates };

  return {
    best: {
      reason: `absMove=${fmtCents(Math.abs(top.chosen.move))}, spread=${fmtCents(top.chosen.spread)}, vol24h=$${Math.round(Number(top.market.volume24hr ?? 0)).toLocaleString()}`,
      ...top,
    },
    snapshotUpdates,
  };
}

export function buildPosition(op, cfg) {
  const now = Date.now();
  const entryPrice = op.chosen.entry.avgPrice;

  return {
    id: `t${now}-${op.market.id}-${op.chosen.tokenId}`,
    openedAt: now,
    marketId: op.market.id,
    question: op.market.question,
    url: op.url,
    tokenId: op.chosen.tokenId,
    notional: cfg.notional,
    entry: {
      avgPrice: entryPrice,
      shares: op.chosen.entry.shares,
      bookBid: op.chosen.bid,
      bookAsk: op.chosen.ask,
      spread: op.chosen.spread,
      reason: op.reason,
    },
    exits: {
      takeProfitPrice: Math.min(0.999, entryPrice + cfg.tp),
      stopLossPrice: Math.max(0.001, entryPrice - cfg.sl),
      maxHoldMs: cfg.maxHoldMs,
    },
    status: 'OPEN',
    lastMark: {
      t: now,
      mid: op.chosen.mid,
      bid: op.chosen.bid,
      ask: op.chosen.ask,
    },
  };
}

export function shouldExit(position, mark) {
  const now = Date.now();
  const ageMs = now - position.openedAt;
  if (ageMs >= position.exits.maxHoldMs) {
    return { reason: 'TIME_STOP', exitAt: now };
  }

  // We assume we can sell roughly at bid.
  const px = mark.bid;
  if (px >= position.exits.takeProfitPrice) {
    return { reason: 'TAKE_PROFIT', exitAt: now };
  }
  if (px <= position.exits.stopLossPrice) {
    return { reason: 'STOP_LOSS', exitAt: now };
  }

  return null;
}
