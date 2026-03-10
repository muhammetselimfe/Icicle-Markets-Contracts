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

## Style
- OpenZeppelin conventions, NatSpec comments required
- All new functions need happy path + edge case tests
- Bug fixes require regression test

## Git Flow
- Base branch: `main`
