// Extremely simple paper trading harness for the MVP.
//
// It does NOT execute real trades. It just keeps a virtual portfolio and
// can be extended later to auto-enter on alerts and auto-exit on rules.

import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_FILE = 'data/paper.json';

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

function parseArgs(argv) {
  const args = { bankroll: 1000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    const next = v ?? argv[i + 1];
    const read = () => (v ? v : (i++, next));
    if (k === 'bankroll') args.bankroll = Number(read());
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  const state = await readJson(STATE_FILE, {
    createdAt: new Date().toISOString(),
    bankroll: args.bankroll,
    cash: args.bankroll,
    positions: [],
    pnl: 0,
  });

  console.log('Paper trading state (MVP scaffold)');
  console.log(JSON.stringify(state, null, 2));

  await writeJson(STATE_FILE, state);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
