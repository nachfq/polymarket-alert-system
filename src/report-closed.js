import fs from 'node:fs/promises';

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function main() {
  const ptr = await readJson('data/last_closed.json', null);
  if (!ptr?.tradeId) return;

  const state = await readJson('data/state.json', null);
  const lastSeen = state?.notifierLastSeen ?? null;
  if (lastSeen === ptr.tradeId) return;

  const closed = await readJson(`data/closed/${ptr.tradeId}.json`, null);
  if (!closed) return;

  // mark seen
  state.notifierLastSeen = ptr.tradeId;
  await fs.writeFile('data/state.json', JSON.stringify(state, null, 2));

  const mins = (closed.durationMs / 60000).toFixed(1);
  const msg = [
    `TRADE_CLOSED ${ptr.tradeId}`,
    `${closed.question}`,
    `entry ${(closed.entryAvg * 100).toFixed(2)}c -> exit ${(closed.exitAvg * 100).toFixed(2)}c | shares ${closed.shares.toFixed(2)}`,
    `PnL $${closed.pnl.toFixed(2)} | reason ${closed.exitReason} | held ${mins}m`,
    `log: data/trades/${ptr.tradeId}.jsonl`,
  ].join('\n');

  console.log(msg);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
