# Icicle Options v1 Contracts

Solidity contracts for the Icicle Options v1 protocol.

## Architecture

- **IcicleOptionsCore (UUPS)**: upgradeable entry core that holds storage and delegates to modules
- **Modules**: Trade, MarketLifecycle, Oracle (Redstone signed-pull), LPVault, Risk
- **Tokens**: IcicleOptionsPosition (upgradeable ERC-721), IcicleOptionsLPShare (upgradeable ERC-20 + permit, ERC-4626-style informational views for an async request/claim vault)
- **Libraries**: ClmsrMath, RiskMath, FeeWaterfallLib, VaultAccountingLib, LazyMulSegmentTree, FixedPointMathU

## Public Interfaces

- `contracts/interfaces/IIcicleOptionsCore.sol` defines the external entrypoints for integrators
- Events and custom errors are declared in core contracts and modules

## Build and Test

```bash
yarn install
yarn hardhat compile
yarn test
yarn lint
```

## Documentation

- Protocol docs: https://docs.signals.wtf
- Deployments: https://docs.signals.wtf/docs/start-here/deployments
- Whitepaper: https://docs.signals.wtf/docs/whitepaper

## Governance and Upgrades

Configuration changes and module wiring are controlled by the governance owner.

## Attribution

Based on [signals-protocol/v1-contract](https://github.com/signals-protocol/v1-contract) (MIT License). Original protocol design and implementation by the [Signals Protocol](https://docs.signals.wtf) team.
