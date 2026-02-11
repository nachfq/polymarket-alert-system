import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_FILE = 'data/state.json';

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

export async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      createdAt: new Date().toISOString(),
      lastScanAt: null,
      openPosition: null,
      lastClosedId: null,
      snapshots: { byToken: {}, t: 0 },
    };
  }
}

export async function writeState(state) {
  await ensureDir(path.dirname(STATE_FILE));
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function appendTradeLog(tradeId, obj) {
  const file = `data/trades/${tradeId}.jsonl`;
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, JSON.stringify(obj) + '\n');
}

export async function writeClosedSummary(tradeId, summary) {
  const file = `data/closed/${tradeId}.json`;
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(summary, null, 2));
  // pointer for the notifier
  await fs.writeFile('data/last_closed.json', JSON.stringify({ tradeId, t: Date.now() }, null, 2));
}
