# Polymarket Alert System (MVP)

**Goal:** generate up to N intraday trading alerts/day for Polymarket markets using only public APIs.

This MVP:
- fetches open markets from `gamma-api.polymarket.com`
- fetches orderbooks from `clob.polymarket.com/book`
- ranks opportunities using simple, explainable heuristics (liquidity/volume, spread/slippage, short-term move)
- stores snapshots locally in `data/` so it can compute changes across runs

## Quickstart

```bash
node -v  # >= 20
npm run scan:once
```

## Scan options

```bash
npm run scan -- --maxAlerts 5 --minVolume24h 5000 --minLiquidity 2000 --notional 200
```

Outputs are printed to stdout (so you can pipe into any notifier).

## Notes

- This is **alerts only**. No automated trading.
- Use at your own risk.

