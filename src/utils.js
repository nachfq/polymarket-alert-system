export const GAMMA_BASE = 'https://gamma-api.polymarket.com';
export const CLOB_BASE = 'https://clob.polymarket.com';

export async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'polymarket-alert-system/0.1',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export function safeParseJsonArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function bestBidAsk(book) {
  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];

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

export function sortedLevels(book, side) {
  const raw = side === 'buy' ? (book?.asks ?? []) : (book?.bids ?? []);
  return raw
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0)
    .sort((a, b) => (side === 'buy' ? a.price - b.price : b.price - a.price));
}

export function marketFill(book, side, notionalUsd) {
  // side: 'buy' consumes asks, 'sell' consumes bids.
  const levels = sortedLevels(book, side);

  let remainingUsd = notionalUsd;
  let shares = 0;
  let cost = 0;

  for (const lvl of levels) {
    const lvlUsd = lvl.price * lvl.size;
    const takeUsd = Math.min(remainingUsd, lvlUsd);
    const takeShares = takeUsd / lvl.price;

    shares += takeShares;
    cost += takeUsd;
    remainingUsd -= takeUsd;

    if (remainingUsd <= 1e-9) break;
  }

  if (cost <= 0 || shares <= 0 || remainingUsd > 1e-6) return null; // insufficient depth

  const avgPrice = cost / shares;
  return { avgPrice, shares, notional: cost };
}

export function fmtCents(x) {
  return `${(x * 100).toFixed(2)}c`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
