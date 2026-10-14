# v1-contract

Solidity smart contracts (Hardhat + Foundry, yarn).

## Hard Exclusion
**Never access or modify `signals-v0/`** — legacy v0 contracts, excluded from all work.

## Build & Test
```bash
yarn install --frozen-lockfile
yarn hardhat compile
npx hardhat typechain        # ABI/type generation
yarn lint                    # tsc --noEmit strict check
yarn test                    # Hardhat tests
```

## Key Paths
- `contracts/` — main v1 contracts
- `contracts/interfaces/` — contract interfaces (changes → SDK ABI regen)
- `contracts/lib/` — math libraries (changes → SDK quote sync)
- `scripts/dispatcher.ts` — deploy/upgrade entrypoint
- `deploy/` — deployment manifests

## Cross-Repo Impact
- Event signature change → v1-subgraph schema + mappings
- Interface change → v1-sdk ABI regen (`npx hardhat typechain`)
- Math/rounding change → v1-sdk quote logic sync

## Deploy Scripts
- `yarn deploy:dev` / `yarn deploy:prod` — contract deployment
- `yarn upgrade:dev` / `yarn upgrade:prod` — proxy upgrade
- `yarn safety-check:dev` / `yarn safety-check:prod` — post-deploy verification

## Market Creation

**IMPORTANT: Always fetch the current live price before creating a market.** Use the Redstone API or on-chain oracle to get the real-time price and set `ANCHOR_PRICE` accordingly. Never reuse a hardcoded anchor price from a previous script — it will be stale.

**IMPORTANT: Use the correct tick unit per asset.** AVAX uses cent-based ticks (tickDivisor=100, e.g. $10.35 → tick 1035). WTI and XAU use dollar-based ticks (tickDivisor=1, e.g. $98 → tick 98, $5009 → tick 5009). Using cent ticks for WTI/XAU creates absurd tick ranges (500K+) that the frontend misidentifies as BTC. Tick spacing must also match: AVAX spacing=5 ($0.05/bin), WTI spacing=1 ($1/bin), XAU spacing=5 ($5/bin).

### Create Market Scripts
```bash
# 15-min test market, $1 ticks (Fuji)
npx hardhat run scripts/ops/create-market-15min-avax.ts --network fuji

# 1-hour market, $0.05 ticks (Fuji)
npx hardhat run scripts/ops/create-market-1hr-avax-5cent.ts --network fuji

# 1-day market, $0.05 ticks (Fuji)
npx hardhat run scripts/ops/create-market-1day-avax-5cent.ts --network fuji

# Configurable market (dev/prod) — full params in script
npx hardhat run scripts/ops/create-market.ts --network dev
```

Requires `DEPLOYER_KEY` in env or `.env` file.

### createMarket() Parameters
```solidity
createMarket(minTick, maxTick, tickSpacing, startTimestamp, endTimestamp,
             settlementTimestamp, numBins, liquidityParameter, feePolicy, seedData)
```
| Parameter | Type | Description |
|-----------|------|-------------|
| minTick | int256 | Lower price bound (inclusive). AVAX: cents (700 = $7.00). BTC: dollars (70000) |
| maxTick | int256 | Upper price bound (exclusive). Must be > minTick |
| tickSpacing | int256 | Price increment per bin. AVAX: 5 = $0.05. BTC: 200 = $200 |
| numBins | uint32 | Must equal `(maxTick - minTick) / tickSpacing`. Max 256 |
| startTimestamp | uint64 | When trading opens |
| endTimestamp | uint64 | When trading closes |
| settlementTimestamp | uint64 | When oracle settlement happens (≥ endTimestamp) |
| liquidityParameter | uint256 | CLMSR alpha in WAD (1e18). 100 WAD = `100000000000000000000` for test |
| feePolicy | address | Fee contract. See `fuji.json` for deployed options (0bps, 10bps, 50bps, 100bps, 200bps) |
| seedData | address | Deployed SeedData contract with packed uint256[] prior factors |

### CLMSR Pricing Mechanics
- **Cost function**: `Cost = α × ln(Z_end / Z_start)` where Z = segment tree root sum
- **LazyMulSegmentTree**: Maintains per-bin factors. Buy q units in bin range → factors scale by `exp(q/α)`
- **Uniform prior**: All factors = 1 WAD → equal probability, ΔEₜ = 0
- **Non-uniform prior**: Custom factors encode initial belief → ΔEₜ > 0 (maker risk premium)
- **Key constants**: WAD = 1e18, MAX_BIN_COUNT = 256, MIN_FACTOR = 0.01 WAD, MAX_FACTOR = 100 WAD
- **Math libs**: `contracts/lib/ClmsrMath.sol`, `contracts/lib/LazyMulSegmentTree.sol`

### Market Examples

**Daily AVAX, $0.05 ticks** (script: `create-market-1day-avax-5cent.ts`):
```
anchorPrice=900, tickSpacing=5, numBins=80
Range: ticks 700–1100 → $7.00–$11.00
Duration: 24h, alpha: 100 WAD, factors: uniform
```

**15-min AVAX, $1 ticks** (script: `create-market-15min-avax.ts`):
```
anchorPrice=9, tickSpacing=1, numBins=10
Range: ticks 4–14 → $4–$14
Duration: 15min, alpha: 100 WAD, factors: uniform
```

**Configurable BTC** (script: `create-market.ts`):
```
minTick=70000, maxTick=90000, tickSpacing=200, numBins=100
Range: $70,000–$90,000, 7-day start delay
Manual alpha or auto-calculated from risk config
```

### SeedData Deployment
```typescript
// Uniform prior (equal probability per bin)
const factors = Array(numBins).fill(WAD); // 1e18 each
const packed = ethers.solidityPacked(Array(numBins).fill("uint256"), factors);
const seedData = await SeedDataFactory.deploy(packed);
// Then: core.createMarket(..., seedData.target)
// Then: core.seedNextChunks(marketId, 50) in loop until all bins seeded
```

### Market Lifecycle Flow
1. Deploy SeedData with packed prior factors (uniform = 1 WAD each)
2. `createMarket()` → returns marketId
3. `seedNextChunks(marketId, 50)` in batches until `isSeeded = true`
4. Trading opens at `startTimestamp`
5. Trading ends at `endTimestamp`, settlement window opens
6. `submitSettlementSample()` called with Redstone signed-pull oracle data
7. Market finalizes after settlement (600s) + pendingOps (300s) windows
8. Users `claimPayout(positionId)` — winning positions get proceeds

### Fee Policies (Fuji Deployed)
| Name | Address | Rate |
|------|---------|------|
| FeePolicyNull | `0xb472...DBc` | 0 bps |
| FeePolicy10bps | `0x16e8...f3d3` | 10 bps (0.1%) |
| FeePolicy50bps | `0x8129...07FE` | 50 bps (0.5%) |
| FeePolicy100bps | `0x61a8...C965` | 100 bps (1%) |
| FeePolicy200bps | `0x38fe...3DF9` | 200 bps (2%) |

### Networks & Environments
| Network | Chain ID | Env file | Command |
|---------|----------|----------|---------|
| Fuji | 43113 | `scripts/environments/fuji.json` | `--network fuji` |
| Citrea testnet | 5115 | `scripts/environments/dev.json` | `--network dev` |
| Citrea mainnet | 4114 | `scripts/environments/prod.json` | `--network prod` |

### Oracle (Redstone)
- Feed ID: `"AVAX"` (Fuji), `"BTC"` (dev/prod)
- Feed decimals: 8
- Settlement: signed-pull oracle via `OracleModule.sol`
- Frontend live price: `api.redstone.finance` REST API (same source)
- Settlement windows: submit=600s, pendingOps=300s, claimDelay=900s
- Redstone price update frequency: ~60 seconds

### Settlement Value Format (CRITICAL)
The contract converts settlementValue to a tick via: `tick = settlementValue / 1_000_000`

**Formula: `settlementValue = price_usd * tickDivisor * 1_000_000`**

| Asset | Tick unit | tickDivisor | Example price | settlementValue | Resulting tick |
|-------|-----------|-------------|---------------|-----------------|----------------|
| AVAX  | cents     | 100         | $9.39         | 939_000_000     | 939            |
| WTI   | dollars   | 1           | $106          | 106_000_000     | 106            |
| XAU   | dollars   | 1           | $2,900        | 2_900_000_000   | 2900           |
| BTC   | dollars   | 1           | $85,000       | 85_000_000_000  | 85000          |

**Wrong:** `price * 1e6` for AVAX gives tick in dollars (9), not cents (939).
**Right:** `price * 100 * 1e6` for AVAX gives correct cent-based tick.

### Batch Processing (CRITICAL)
**NEVER process empty or future batches.** The contract uses `currentBatchId` to gate market creation: `createMarket` requires `settlementBatch > currentBatchId`. Processing an empty batch advances the pointer, which blocks all market creation for that entire batch window (8 hours). Only process a batch when it contains settled market P&L data, and only when explicitly asked.

**Batch boundaries use `BATCH_TIMEZONE_OFFSET = 28800` (8h UTC).** Batches run from 08:00 UTC to 08:00 UTC (midnight PST), NOT midnight UTC. Formula: `batchId = (timestamp - 28800) / 86400`. Batch start: `batchId * 86400 + 28800`.

### Secondary Settlement (Manual Fallback)
When oracle settlement is missed (window expires without `submitSettlementSample`):
1. `markSettlementFailed(marketId)` — owner/operator marks oracle as absent
2. `finalizeSecondarySettlement(marketId, settlementValue)` — owner settles with manual price
3. `requestSettlementChunks(marketId, 25)` — snapshot positions (may auto-complete)

Script: `npx hardhat run scripts/ops/settle-all-expired.ts --network fuji`

## Style
- OpenZeppelin conventions, NatSpec comments required
- All new functions need happy path + edge case tests
- Bug fixes require regression test

## Git Flow
- Base branch: `main`
