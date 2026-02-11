import fs from 'node:fs/promises';
import path from 'node:path';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';

function parseArgs(argv) {
  const args = {
    maxAlerts: 5,
    limit: 200,
    minVolume24h: 3000,
    minLiquidity: 1500,
    notional: 100,
    maxEndHours: 24 * 365 * 2, // allow long-dated markets; intraday trading can happen anywhere
    maxSpread: 0.12,
    snapshotFile: 'data/snapshots.json',
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    const next = v ?? argv[i + 1];
    const read = () => (v ? v : (i++, next));

    if (k === 'maxAlerts') args.maxAlerts = Number(read());
    if (k === 'limit') args.limit = Number(read());
    if (k === 'minVolume24h') args.minVolume24h = Number(read());
    if (k === 'minLiquidity') args.minLiquidity = Number(read());
    if (k === 'notional') args.notional = Number(read());
    if (k === 'maxEndHours') args.maxEndHours = Number(read());
    if (k === 'maxSpread') args.maxSpread = Number(read());
    if (k === 'snapshotFile') args.snapshotFile = String(read());
  }

  return args;
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'polymarket-alert-system-mvp/0.1',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function safeParseJsonArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function bestBidAsk(book) {
  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];

  // Don’t assume the API returns sorted levels.
  let bestBid = null;
  for (const b of bids) {
    const p = Number(b.price);
    if (!Number.isFinite(p)) continue;
    if (bestBid === null || p > bestBid) bestBid = p;
  }

  let bestAsk = null;
  for (const a of asks) {
    const p = Number(a.price);
    if (!Number.isFinite(p)) continue;
    if (bestAsk === null || p < bestAsk) bestAsk = p;
  }

  return { bestBid, bestAsk };
}

function slippageForNotional(book, side, notionalUsd) {
  // side: 'buy' consumes asks, 'sell' consumes bids.
  // We treat prices in [0,1] USD per share. size is shares.
  const rawLevels = side === 'buy' ? (book?.asks ?? []) : (book?.bids ?? []);
  const levels = rawLevels
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0)
    .sort((a, b) => (side === 'buy' ? a.price - b.price : b.price - a.price));
  let remainingUsd = notionalUsd;
  let shares = 0;
  let cost = 0;
  for (const lvl of levels) {
    const p = lvl.price;
    const s = lvl.size;
    const lvlUsd = p * s;
    const takeUsd = Math.min(remainingUsd, lvlUsd);
    const takeShares = takeUsd / p;
    shares += takeShares;
    cost += takeUsd;
    remainingUsd -= takeUsd;
    if (remainingUsd <= 1e-9) break;
  }
  if (cost <= 0 || shares <= 0 || remainingUsd > 1e-6) return null; // not enough depth
  const avg = cost / shares;
  const { bestBid, bestAsk } = bestBidAsk(book);
  const ref = side === 'buy' ? bestAsk : bestBid;
  if (!ref) return null;
  const slip = Math.abs(avg - ref);
  return { avgPrice: avg, refPrice: ref, slippage: slip, shares };
}

function opportunityScore({ spread, vol24h, liq, absMove1h, slipBuy, slipSell }) {
  // Simple, explainable scoring. 0..100.
  // Reward: high vol/liquidity, meaningful move; Penalize: wide spread, high slippage.
  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  const volScore = clamp01(Math.log10(1 + vol24h) / 5); // ~0..1
  const liqScore = clamp01(Math.log10(1 + liq) / 5);
  const moveScore = clamp01(absMove1h / 0.08); // 8c move in 1h is strong
  const spreadPenalty = clamp01(spread / 0.02); // 2c spread is bad
  const slipPenalty = clamp01(((slipBuy ?? 0) + (slipSell ?? 0)) / 0.04); // 4c combined is bad

  const raw =
    45 * volScore +
    25 * liqScore +
    30 * moveScore -
    25 * spreadPenalty -
    25 * slipPenalty;

  return Math.round(Math.max(0, Math.min(100, raw)));
}

function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtCents(x) {
  return `${(x * 100).toFixed(1)}c`;
}

async function main() {
  const args = parseArgs(process.argv);

  const prev = await readJson(args.snapshotFile, { t: 0, byToken: {} });
  const now = Date.now();

  const markets = await fetchJson(
    `${GAMMA_BASE}/markets?closed=false&limit=${args.limit}&order=volume24hr&ascending=false`
  );

  const endCutoffMs = now + args.maxEndHours * 3600_000;

  // Filter: active markets, orderbook enabled, not restricted (optional), near-term, decent volume/liquidity.
  const candidates = markets
    .filter((m) => m && m.closed === false)
    .filter((m) => m.enableOrderBook)
    .filter((m) => Number(m.volume24hr ?? 0) >= args.minVolume24h)
    .filter((m) => Number(m.liquidityNum ?? m.liquidity ?? 0) >= args.minLiquidity)
    .filter((m) => {
      const end = Date.parse(m.endDate);
      return Number.isFinite(end) && end > now && end < endCutoffMs;
    })
    .slice(0, 30); // keep it light: we will hit orderbook endpoint per market

  const rows = [];

  for (const m of candidates) {
    const outcomes = safeParseJsonArray(m.outcomes);
    const prices = safeParseJsonArray(m.outcomePrices).map(Number);
    const tokenIds = safeParseJsonArray(m.clobTokenIds);
    if (outcomes.length < 2 || prices.length < 2 || tokenIds.length < 2) continue;

    // Token ids correspond to outcomes/outcomePrices ordering, but some markets are multi-outcome
    // (sports) and token order can be confusing. We pick the token whose book mid is closest to
    // the last-traded/outcome price from Gamma.

    const url = `https://polymarket.com/market/${m.slug}`;

    const tokenCandidates = [];

    for (let idx = 0; idx < Math.min(tokenIds.length, prices.length); idx++) {
      const token = String(tokenIds[idx]);
      const refPrice = Number(prices[idx]);
      if (!Number.isFinite(refPrice)) continue;

      let book;
      try {
        book = await fetchJson(`${CLOB_BASE}/book?token_id=${token}`);
      } catch {
        continue;
      }

      const { bestBid, bestAsk } = bestBidAsk(book);
      if (!bestBid || !bestAsk) continue;

      const mid = (bestBid + bestAsk) / 2;
      const spread = bestAsk - bestBid;

      tokenCandidates.push({ idx, token, refPrice, book, bestBid, bestAsk, mid, spread, err: Math.abs(mid - refPrice) });
    }

    if (tokenCandidates.length === 0) continue;

    tokenCandidates.sort((a, b) => a.err - b.err);
    const chosen = tokenCandidates[0];

    const prevKey = `${chosen.token}`;
    const prevEntry = prev.byToken?.[prevKey];
    const prevMid = prevEntry?.mid ?? null;
    const absMove1h = prevMid ? Math.abs(chosen.mid - prevMid) : 0;

    const slipBuyObj = slippageForNotional(chosen.book, 'buy', args.notional);
    const slipSellObj = slippageForNotional(chosen.book, 'sell', args.notional);
    const slipBuy = slipBuyObj?.slippage ?? null;
    const slipSell = slipSellObj?.slippage ?? null;

    // Hard filters to avoid garbage books.
    if (chosen.spread > args.maxSpread) continue;
    // Require we can at least enter with this notional.
    if (slipBuy == null) continue;

    const score = opportunityScore({
      spread: chosen.spread,
      vol24h: Number(m.volume24hr ?? 0),
      liq: Number(m.liquidityNum ?? 0),
      absMove1h,
      slipBuy,
      slipSell,
    });

    rows.push({
      score,
      question: m.question,
      url,
      marketId: m.id,
      endDate: m.endDate,
      vol24h: Number(m.volume24hr ?? 0),
      liq: Number(m.liquidityNum ?? 0),
      bestBid: chosen.bestBid,
      bestAsk: chosen.bestAsk,
      mid: chosen.mid,
      spread: chosen.spread,
      absMove1h,
      slipBuy,
      slipSell,
      token: chosen.token,
      refPrice: chosen.refPrice,
    });

    // record snapshot
    prev.byToken[prevKey] = { mid: chosen.mid, bestBid: chosen.bestBid, bestAsk: chosen.bestAsk, t: now };
  }

  // Save snapshots
  prev.t = now;
  await writeJson(args.snapshotFile, prev);

  rows.sort((a, b) => b.score - a.score);
  const top = rows.slice(0, args.maxAlerts);

  const header = `Polymarket intraday alerts (MVP) — ${new Date(now).toISOString()}\n`;
  console.log(header);

  if (top.length === 0) {
    console.log('No candidates matched the current filters. Try lowering minVolume24h/minLiquidity or increasing maxEndHours.');
    return;
  }

  for (const r of top) {
    const timeLeftH = (Date.parse(r.endDate) - now) / 3600_000;
    const lines = [
      `Score ${r.score}/100 — ${r.question}`,
      `URL: ${r.url}`,
      `Mid ${fmtCents(r.mid)} | Bid ${fmtCents(r.bestBid)} / Ask ${fmtCents(r.bestAsk)} | Spread ${fmtCents(r.spread)}`,
      `Vol24h $${Math.round(r.vol24h).toLocaleString()} | Liq $${Math.round(r.liq).toLocaleString()} | Ends in ${timeLeftH.toFixed(1)}h`,
      `Move since last scan: ${fmtCents(r.absMove1h)} | Slippage($${args.notional}) buy:${r.slipBuy != null ? fmtCents(r.slipBuy) : 'n/a'} sell:${r.slipSell != null ? fmtCents(r.slipSell) : 'n/a'}`,
      `Why it’s flagged: near-term + liquid + tight-ish book + moving (intraday tradable).`,
      '---',
    ];
    console.log(lines.join('\n'));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
