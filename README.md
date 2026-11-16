# Giwajang

A minimal launchpad on **GIWA Sepolia** (chainId 91342) built with the
**Ammora SDK** (`@ammora-protocol/sdk@0.3.9`) and viem. Testnet demo — GIWA
Sepolia assets have no real-world value; the Ammora contracts are unaudited beta.

## What it does

- **Markets** — live bonding-curve state (price, quote reserve, graduation
  progress, Config id) read straight from the chain for every known launch.
  Ships with the Giwamora (GMORA) market created on 2026-11-16.
- **Trade** — buy/sell on a launch curve from the visitor's own browser wallet:
  SDK quote at a pinned block, exact-amount ERC-20 approval to the curve,
  optional ETH→WETH wrap when the WETH balance is short, then
  `swapExactInput` with a 0.5% slippage floor. Partial fills at the graduation
  boundary are refused.
- **Launch a token** — creates a brand-new Config derived from the reviewed
  public template (Config #6, hash-pinned in the app), the token, its bonding
  curve and a first buy, atomically via `createConfigAndPoolWithFirstBuy`
  (one exact WETH approval, then one create transaction). All fee / LP /
  leftover recipients are the connected wallet. New launches are remembered in
  `localStorage` and appear in Markets/Trade.

## Use it

Open `giwajang.html` (single-file build, no server needed) in a browser with
MetaMask, or run the project:

```bash
npm install
npm run dev      # local dev server
npm run build    # type-check + production build into dist/
node make-single.mjs   # rebuild giwajang.html from dist/
```

Connect a wallet on GIWA Sepolia (the app offers to add the network), fund it
from the GIWA faucet, and trade or launch.

## Notes

- Config derivation in `src/main.ts` is adapted from the MIT-licensed
  `ammora-examples` (`src/launch/config-from-template.ts`) by KreoLabs.
- The launch flow pins template #6 by its on-chain config hash
  (`0x60489087…e667`, verified 2026-11-16) and aborts if the template changes.
- `dev/` holds the browser-verification harness used during development
  (headless Chrome + a TLS relay that works around this sandbox's egress
  proxy). It is not part of the app.

## The name

**Giwajang** (기와장, also written *giwatjang*) is one piece of roof tile — a wide, flat sheet of clay, cement or metal made for covering roofs. GIWA (기와) is the same tile: the chain itself is named after it. The mark in `logo.svg` is a *gwimyeon* (귀면) — the demon face carved into traditional Korean roof tile ends to guard the house — drawn on the outline of a single giwajang slab, studded border and all. One tile guards the roof; every launch lays one more. Every launch on Giwajang is one more tile on the GIWA roof.
