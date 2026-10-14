// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./IcicleOptionsCoreStorage.sol";
import "../interfaces/IIcicleOptionsCore.sol";
import "../interfaces/IIcicleOptionsPosition.sol";
import "../interfaces/IRiskModule.sol";
import "../errors/IcicleOptionsErrors.sol";

/// @title IcicleOptionsCore
/// @notice Upgradeable entry core that holds storage and delegates to modules
contract IcicleOptionsCore is
    Initializable,
    IIcicleOptionsCore,
    IcicleOptionsCoreStorage,
    IcicleOptionsErrors,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    uint256 internal constant WAD = 1e18;

    address public tradeModule;
    address public lifecycleModule;
    address public riskModule;
    address public vaultModule;
    address public oracleModule;

    // ============================================================
    // Events
    // ============================================================
    event RiskConfigUpdated(uint256 lambda, uint256 kDrawdown, bool enforceAlpha);
    event FeeWaterfallConfigUpdated(uint256 rhoBS, int256 pdd, uint256 phiLP, uint256 phiBS, uint256 phiTR);
    event WithdrawalLagUpdated(uint64 lag);
    event ModulesUpdated(address trade, address lifecycle, address risk, address vault, address oracle);

    // ============================================================
    // Modifiers
    // ============================================================
    modifier onlyOwnerOrOperator() {
        // Pause is an incident-response switch.
        // While paused, restrict operator actions and require owner-only.
        if (paused()) {
            if (msg.sender != owner()) revert IcicleOptionsErrors.UnauthorizedCaller(msg.sender);
        } else {
            if (msg.sender != owner() && !_operators[msg.sender]) {
                revert IcicleOptionsErrors.UnauthorizedCaller(msg.sender);
            }
        }
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    struct InitParams {
        address paymentToken;
        address positionContract;
        address lpShareToken;
        address tradeModule;
        address lifecycleModule;
        address riskModule;
        address vaultModule;
        address oracleModule;
        address ownerSafe;
        uint64 settlementSubmitWindow;
        uint64 pendingOpsWindow;
        uint64 claimDelaySeconds;
        bytes32 redstoneFeedId;
        uint8 redstoneFeedDecimals;
        uint64 maxSampleDistance;
        uint64 futureTolerance;
        uint256 lambda;
        uint256 kDrawdown;
        bool enforceAlpha;
        uint256 rhoBS;
        uint256 phiLP;
        uint256 phiBS;
        uint256 phiTR;
        uint64 withdrawalLagBatches;
        address[] operatorAllowlist;
    }

    /// @notice Core initializer
    function initialize(InitParams calldata params) external initializer {
        if (params.ownerSafe == address(0)) revert IcicleOptionsErrors.ZeroAddress();
        __Ownable_init(params.ownerSafe);
        __UUPSUpgradeable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        _requireAddress(params.paymentToken);
        _requireAddress(params.positionContract);
        _requireAddress(params.lpShareToken);
        _requireAddress(params.tradeModule);
        _requireAddress(params.lifecycleModule);
        _requireAddress(params.riskModule);
        _requireAddress(params.vaultModule);
        _requireAddress(params.oracleModule);

        _requireContract(params.paymentToken);
        _requireContract(params.positionContract);
        _requireContract(params.lpShareToken);
        _requireContract(params.tradeModule);
        _requireContract(params.lifecycleModule);
        _requireContract(params.riskModule);
        _requireContract(params.vaultModule);
        _requireContract(params.oracleModule);

        if (params.claimDelaySeconds != params.settlementSubmitWindow + params.pendingOpsWindow) {
            revert IcicleOptionsErrors.InvalidSettlementTimeline(
                params.claimDelaySeconds,
                params.settlementSubmitWindow,
                params.pendingOpsWindow
            );
        }
        if (params.phiLP + params.phiBS + params.phiTR != WAD) {
            revert IcicleOptionsErrors.InvalidFeeSplitSum(params.phiLP, params.phiBS, params.phiTR);
        }
        if (params.lambda == 0 || params.lambda >= WAD) revert IcicleOptionsErrors.InvalidLambda(params.lambda);
        // maxSampleDistance == 0 is a "disable staleness" sentinel; the trade-freshness gate
        // (_requireFreshOracle) would then let dynamic trades price against an arbitrarily old
        // oracle (adverse-selection drain). Require a real bound.
        if (params.maxSampleDistance == 0) revert IcicleOptionsErrors.InvalidMaxSampleDistance(params.maxSampleDistance);

        paymentToken = IERC20(params.paymentToken);
        positionContract = IIcicleOptionsPosition(params.positionContract);
        lpShareToken = params.lpShareToken;
        tradeModule = params.tradeModule;
        lifecycleModule = params.lifecycleModule;
        riskModule = params.riskModule;
        vaultModule = params.vaultModule;
        oracleModule = params.oracleModule;

        settlementSubmitWindow = params.settlementSubmitWindow;
        pendingOpsWindow = params.pendingOpsWindow;
        claimDelaySeconds = params.claimDelaySeconds;
        redstoneFeedId = params.redstoneFeedId;
        redstoneFeedDecimals = params.redstoneFeedDecimals;
        maxSampleDistance = params.maxSampleDistance;
        futureTolerance = params.futureTolerance;

        riskConfig.lambda = params.lambda;
        riskConfig.kDrawdown = params.kDrawdown;
        riskConfig.enforceAlpha = params.enforceAlpha;
        feeWaterfallConfig.pdd = -int256(params.lambda);
        feeWaterfallConfig.rhoBS = params.rhoBS;
        feeWaterfallConfig.phiLP = params.phiLP;
        feeWaterfallConfig.phiBS = params.phiBS;
        feeWaterfallConfig.phiTR = params.phiTR;

        withdrawalLagBatches = params.withdrawalLagBatches;

        uint256 operatorCount = params.operatorAllowlist.length;
        for (uint256 i = 0; i < operatorCount; i++) {
            address operator = params.operatorAllowlist[i];
            if (operator == address(0)) revert IcicleOptionsErrors.ZeroAddress();
            _operators[operator] = true;
            emit OperatorUpdated(operator, true);
        }

        emit ModulesUpdated(
            params.tradeModule,
            params.lifecycleModule,
            params.riskModule,
            params.vaultModule,
            params.oracleModule
        );
    }

    /// @notice Set module addresses
    function setModules(
        address _tradeModule,
        address _lifecycleModule,
        address _riskModule,
        address _vaultModule,
        address _oracleModule
    ) external onlyOwner {
        _requireAddress(_tradeModule);
        _requireAddress(_lifecycleModule);
        _requireAddress(_riskModule);
        _requireAddress(_vaultModule);
        _requireAddress(_oracleModule);
        _requireContract(_tradeModule);
        _requireContract(_lifecycleModule);
        _requireContract(_riskModule);
        _requireContract(_vaultModule);
        _requireContract(_oracleModule);
        tradeModule = _tradeModule;
        lifecycleModule = _lifecycleModule;
        riskModule = _riskModule;
        vaultModule = _vaultModule;
        oracleModule = _oracleModule;
        emit ModulesUpdated(_tradeModule, _lifecycleModule, _riskModule, _vaultModule, _oracleModule);
    }

    /// @notice Add or remove operator from allowlist
    function setOperator(address operator, bool allowed) external onlyOwner {
        if (operator == address(0)) revert IcicleOptionsErrors.ZeroAddress();
        _operators[operator] = allowed;
        emit OperatorUpdated(operator, allowed);
    }

    function operators(address operator) external view override returns (bool) {
        return _operators[operator];
    }

    // ============================================================
    // Emergency Pause
    // ============================================================

    /// @notice Pause core entrypoints guarded by `whenNotPaused`
    /// @dev Intended as an incident response tool (replaces market "reopen" flows).
    ///      Claims remain available while paused.
    function pause() external onlyOwnerOrOperator whenNotPaused {
        _pause();
    }

    /// @notice Unpause core entrypoints guarded by `whenNotPaused`
    function unpause() external onlyOwner whenPaused {
        _unpause();
    }

    // ============================================================
    // Vault Configuration
    // ============================================================

    function setWithdrawalLagBatches(uint64 lag) external onlyOwner {
        withdrawalLagBatches = lag;
        emit WithdrawalLagUpdated(lag);
    }

    /// @notice Configure fee waterfall parameters (except pdd)
    /// @dev Per WP v2: pdd := -λ is enforced via setRiskConfig to maintain the NAV floor invariant.
    ///      This function does NOT accept pdd parameter to prevent breaking the invariant.
    ///      Use setRiskConfig to change the NAV loss floor (via λ).
    function setFeeWaterfallConfig(
        uint256 rhoBS,
        uint256 phiLP,
        uint256 phiBS,
        uint256 phiTR
    ) external onlyOwner {
        if (phiLP + phiBS + phiTR != WAD) revert IcicleOptionsErrors.InvalidFeeSplitSum(phiLP, phiBS, phiTR);
        // pdd is NOT set here - it's controlled by setRiskConfig (pdd := -λ)
        feeWaterfallConfig.rhoBS = rhoBS;
        feeWaterfallConfig.phiLP = phiLP;
        feeWaterfallConfig.phiBS = phiBS;
        feeWaterfallConfig.phiTR = phiTR;
        emit FeeWaterfallConfigUpdated(rhoBS, feeWaterfallConfig.pdd, phiLP, phiBS, phiTR);
    }

    // ============================================================
    // Capital Stack Funding
    // ============================================================

    function fundBackstop(uint256 amount6) external whenNotPaused nonReentrant {
        _delegate(vaultModule, abi.encodeWithSignature("fundBackstop(uint256)", amount6));
    }

    function withdrawBackstop(uint256 amount6) external onlyOwner nonReentrant {
        _delegate(vaultModule, abi.encodeWithSignature("withdrawBackstop(uint256,address)", amount6, owner()));
    }

    function fundTreasury(uint256 amount6) external whenNotPaused nonReentrant {
        _delegate(vaultModule, abi.encodeWithSignature("fundTreasury(uint256)", amount6));
    }

    function withdrawTreasury(uint256 amount6) external onlyOwner nonReentrant {
        _delegate(vaultModule, abi.encodeWithSignature("withdrawTreasury(uint256,address)", amount6, owner()));
    }

    /// @notice Configure risk parameters for α Safety Bounds
    /// @dev Invariant: pdd := -λ (NAV loss floor equals negative lambda)
    ///      This function enforces the relationship by auto-updating pdd when lambda is set.
    ///      λ ∈ (0, 1) is required for safety invariants.
    /// @param lambda λ: NAV loss limit per batch (WAD), e.g., 0.3e18 = 30% floor. Must be in (0, 1).
    /// @param kDrawdown k: Peak drawdown sensitivity for alpha limit (WAD), typically 1.0e18
    /// @param enforceAlpha Whether to enforce α bounds at market creation time (createMarket)
    function setRiskConfig(
        uint256 lambda,
        uint256 kDrawdown,
        bool enforceAlpha
    ) external onlyOwner {
        // λ must be in (0, 1) for safety invariants
        // λ = 0 would mean no NAV loss limit (unsafe)
        // λ >= 1 would mean floor cannot be maintained (100%+ drop allowed is meaningless)
        if (lambda == 0 || lambda >= WAD) revert IcicleOptionsErrors.InvalidLambda(lambda);

        riskConfig.lambda = lambda;
        riskConfig.kDrawdown = kDrawdown;
        riskConfig.enforceAlpha = enforceAlpha;
        
        // Invariant: pdd := -λ
        // Auto-update NAV floor to maintain Safety guarantee
        feeWaterfallConfig.pdd = -int256(lambda);
        
        emit RiskConfigUpdated(lambda, kDrawdown, enforceAlpha);
    }

    // --- External stubs: delegate to modules ---

    function openPosition(
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint128 quantity,
        uint256 maxCost
    ) external override whenNotPaused nonReentrant returns (uint256 positionId) {
        // Risk gate first: validate exposure caps before position modification
        _riskGate(abi.encodeCall(
            IRiskModule.gateOpenPosition,
            (marketId, msg.sender, quantity)
        ));

        bytes memory ret = _delegate(tradeModule, abi.encodeCall(
            IIcicleOptionsCore.openPosition,
            (marketId, lowerTick, upperTick, quantity, maxCost)
        ));
        if (ret.length > 0) positionId = abi.decode(ret, (uint256));
    }

    function increasePosition(
        uint256 positionId,
        uint128 quantity,
        uint256 maxCost
    ) external override whenNotPaused nonReentrant {
        // Risk gate first: validate exposure caps before position modification
        _riskGate(abi.encodeCall(
            IRiskModule.gateIncreasePosition,
            (positionId, msg.sender, quantity)
        ));

        _delegate(tradeModule, abi.encodeCall(
            IIcicleOptionsCore.increasePosition,
            (positionId, quantity, maxCost)
        ));
    }

    function decreasePosition(
        uint256 positionId,
        uint128 quantity,
        uint256 minProceeds
    ) external override whenNotPaused nonReentrant {
        _delegate(tradeModule, abi.encodeCall(
            IIcicleOptionsCore.decreasePosition,
            (positionId, quantity, minProceeds)
        ));
    }

    function closePosition(
        uint256 positionId,
        uint256 minProceeds
    ) external override whenNotPaused nonReentrant {
        _delegate(tradeModule, abi.encodeCall(
            IIcicleOptionsCore.closePosition,
            (positionId, minProceeds)
        ));
    }

    /// @notice Claim payout from settled position
    /// @dev Allowed even when paused - user funds should always be claimable after settlement
    function claimPayout(uint256 positionId) external override nonReentrant {
        _delegate(tradeModule, abi.encodeCall(IIcicleOptionsCore.claimPayout, (positionId)));
    }

    /// @notice Batch claim payouts from multiple settled positions
    /// @dev Allowed even when paused - user funds should always be claimable after settlement
    function batchClaimPayout(uint256[] calldata positionIds) external override nonReentrant {
        _delegate(tradeModule, abi.encodeCall(IIcicleOptionsCore.batchClaimPayout, (positionIds)));
    }

    // ---- View stubs ----

    function calculateOpenCost(
        uint256 marketId,
        int256 lowerTick,
        int256 upperTick,
        uint128 quantity
    ) external override returns (uint256 cost) {
        bytes memory ret = _delegateView(tradeModule, abi.encodeCall(
            IIcicleOptionsCore.calculateOpenCost,
            (marketId, lowerTick, upperTick, quantity)
        ));
        if (ret.length > 0) cost = abi.decode(ret, (uint256));
    }

    function calculateIncreaseCost(
        uint256 positionId,
        uint128 quantity
    ) external override returns (uint256 cost) {
        bytes memory ret = _delegateView(tradeModule, abi.encodeCall(
            IIcicleOptionsCore.calculateIncreaseCost,
            (positionId, quantity)
        ));
        if (ret.length > 0) cost = abi.decode(ret, (uint256));
    }

    function calculateDecreaseProceeds(
        uint256 positionId,
        uint128 quantity
    ) external override returns (uint256 proceeds) {
        bytes memory ret = _delegateView(tradeModule, abi.encodeCall(
            IIcicleOptionsCore.calculateDecreaseProceeds,
            (positionId, quantity)
        ));
        if (ret.length > 0) proceeds = abi.decode(ret, (uint256));
    }

    function calculateCloseProceeds(
        uint256 positionId
    ) external override returns (uint256 proceeds) {
        bytes memory ret = _delegateView(tradeModule, abi.encodeCall(
            IIcicleOptionsCore.calculateCloseProceeds,
            (positionId)
        ));
        if (ret.length > 0) proceeds = abi.decode(ret, (uint256));
    }

    function calculatePositionValue(
        uint256 positionId
    ) external override returns (uint256 value) {
        bytes memory ret = _delegateView(tradeModule, abi.encodeCall(
            IIcicleOptionsCore.calculatePositionValue,
            (positionId)
        ));
        if (ret.length > 0) value = abi.decode(ret, (uint256));
    }

    // --- Lifecycle / oracle ---

    /// @notice Create a new market with prior-based factors stored in SeedData
    /// @dev Core-first Risk Gate pattern:
    ///      1. Core calls RiskModule.gateCreateMarket FIRST (α limit + prior admissibility)
    ///      2. Core delegates to MarketLifecycleModule (state machine, storage)
    function createMarket(
        int256 minTick,
        int256 maxTick,
        int256 tickSpacing,
        uint64 startTimestamp,
        uint64 endTimestamp,
        uint64 settlementTimestamp,
        uint32 numBins,
        uint256 liquidityParameter,
        address feePolicy,
        address seedData
    ) public override onlyOwnerOrOperator returns (uint256 marketId) {
        // Risk gate first: validate α bounds and prior admissibility
        _riskGate(abi.encodeCall(
            IRiskModule.gateCreateMarket,
            (liquidityParameter, numBins, seedData)
        ));

        // Then delegate to lifecycle module (state machine only, risk already validated)
        bytes memory ret = _delegate(lifecycleModule, abi.encodeWithSignature(
            "createMarket(int256,int256,int256,uint64,uint64,uint64,uint32,uint256,address,address)",
            minTick,
            maxTick,
            tickSpacing,
            startTimestamp,
            endTimestamp,
            settlementTimestamp,
            numBins,
            liquidityParameter,
            feePolicy,
            seedData
        ));
        if (ret.length > 0) marketId = abi.decode(ret, (uint256));
    }

    /// @notice Create a market with v2 oracle-anchored dynamic pricing.
    /// @dev Forwards msg.data to preserve the DynamicParams tuple without re-encoding.
    function createMarketDynamic(
        int256 minTick,
        int256 maxTick,
        int256 tickSpacing,
        uint64 startTimestamp,
        uint64 endTimestamp,
        uint64 settlementTimestamp,
        uint32 numBins,
        uint256 liquidityParameter,
        address feePolicy,
        address seedData,
        IIcicleOptionsCore.DynamicParams calldata dp
    ) external onlyOwnerOrOperator returns (uint256 marketId) {
        (minTick, maxTick, tickSpacing, startTimestamp, endTimestamp, settlementTimestamp, feePolicy, dp); // silence unused
        _riskGate(abi.encodeCall(
            IRiskModule.gateCreateMarket,
            (liquidityParameter, numBins, seedData)
        ));
        bytes memory ret = _delegate(lifecycleModule, msg.data);
        if (ret.length > 0) marketId = abi.decode(ret, (uint256));
    }

    function finalizePrimarySettlement(uint256 marketId) external override onlyOwnerOrOperator {
        _delegate(lifecycleModule, abi.encodeWithSignature("finalizePrimarySettlement(uint256)", marketId));
    }

    function markSettlementFailed(uint256 marketId) external override onlyOwnerOrOperator {
        _delegate(lifecycleModule, abi.encodeWithSignature("markSettlementFailed(uint256)", marketId));
    }

    function finalizeSecondarySettlement(
        uint256 marketId,
        int256 settlementValue
    ) external override onlyOwner {
        _delegate(lifecycleModule, abi.encodeWithSignature(
            "finalizeSecondarySettlement(uint256,int256)",
            marketId,
            settlementValue
        ));
    }

    function seedNextChunks(uint256 marketId, uint32 count) public override onlyOwnerOrOperator {
        _delegate(lifecycleModule, abi.encodeWithSignature("seedNextChunks(uint256,uint32)", marketId, count));
    }

    function updateMarketTiming(
        uint256 marketId,
        uint64 startTimestamp,
        uint64 endTimestamp,
        uint64 settlementTimestamp
    ) external override onlyOwner {
        _delegate(lifecycleModule, abi.encodeWithSignature(
            "updateMarketTiming(uint256,uint64,uint64,uint64)",
            marketId,
            startTimestamp,
            endTimestamp,
            settlementTimestamp
        ));
    }

    /// @notice Submit settlement sample with Redstone signed-pull oracle
    /// @dev Permissionless during SettlementOpen. Redstone payload is appended to calldata.
    ///      Signatures are verified on-chain by the OracleModule.
    /// @param marketId Market to submit settlement for
    function submitSettlementSample(uint256 marketId) external whenNotPaused {
        // Forward full msg.data to preserve Redstone payload appended by WrapperBuilder
        (marketId); // silence unused parameter warning
        _delegate(oracleModule, msg.data);
    }

    /// @notice Refresh the cached oracle tick for a dynamic market's trade pricing.
    /// @dev Redstone payload appended to calldata; forward msg.data to preserve it.
    function refreshTradeOracle(uint256 marketId) external whenNotPaused {
        (marketId); // silence unused parameter warning
        _delegate(oracleModule, msg.data);
    }

    /// @notice Configure Redstone oracle parameters
    /// @dev Set feed ID, decimals, and timing constraints
    function setRedstoneConfig(
        bytes32 feedId,
        uint8 feedDecimals,
        uint64 _maxSampleDistance,
        uint64 _futureTolerance
    ) external onlyOwner {
        _delegate(oracleModule, abi.encodeWithSignature(
            "setRedstoneConfig(bytes32,uint8,uint64,uint64)",
            feedId,
            feedDecimals,
            _maxSampleDistance,
            _futureTolerance
        ));
    }

    /// @notice Set settlement timeline parameters (WP v2 state machine)
    /// @param _sampleWindow Δsettle: SettlementOpen duration for sample submission
    /// @param _opsWindow Δops: PendingOps duration
    /// @param _claimDelay Δclaim: Delay before claims open after Tset
    function setSettlementTimeline(
        uint64 _sampleWindow,
        uint64 _opsWindow,
        uint64 _claimDelay
    ) external onlyOwner {
        if (_claimDelay != _sampleWindow + _opsWindow) {
            revert IcicleOptionsErrors.InvalidSettlementTimeline(_claimDelay, _sampleWindow, _opsWindow);
        }
        settlementSubmitWindow = _sampleWindow;
        pendingOpsWindow = _opsWindow;
        claimDelaySeconds = _claimDelay;
    }

    /// @notice Configure the batch accounting period (seconds). 0 => 86400 daily default.
    /// @dev Shorter periods realize LP P&L more frequently (e.g. 900 = 15-min batches on testnet).
    ///      Bounded to [60s, 7 days]. Must be a divisor-aligned value vs the timezone offset is
    ///      not required, but keep it sane.
    function setBatchSeconds(uint64 _batchSeconds) external onlyOwner {
        if (_batchSeconds < 60 || _batchSeconds > 7 * 86_400) revert IcicleOptionsErrors.BatchSecondsOutOfRange(_batchSeconds);
        // Lock the period once the vault is live. currentBatchId is an absolute window
        // index on the CURRENT period; changing the period afterwards rescales every future
        // _toBatchId() while the stored pointer keeps its old-scale value, permanently
        // bricking processDailyBatch (batchId == currentBatchId+1) and market creation
        // (settlementBatch > currentBatchId). Set the cadence at deploy, before seeding.
        if (lpVault.isSeeded) revert IcicleOptionsErrors.BatchPeriodLocked();
        batchSeconds = _batchSeconds;
    }

    /// @notice Get market state (derived from timestamps)
    /// @return state 0=Trading, 1=SettlementOpen, 2=PendingOps, 3=FinalizedPrimary, 4=FinalizedSecondary, 5=FailedPendingManual
    function getMarketState(uint256 marketId) external returns (uint8 state) {
        bytes memory ret = _delegateView(oracleModule, abi.encodeWithSignature(
            "getMarketState(uint256)",
            marketId
        ));
        if (ret.length > 0) state = abi.decode(ret, (uint8));
    }

    /// @notice Get settlement windows for a market
    function getSettlementWindows(uint256 marketId) external returns (
        uint64 tSet,
        uint64 settleEnd,
        uint64 opsEnd,
        uint64 claimOpen
    ) {
        bytes memory ret = _delegateView(oracleModule, abi.encodeWithSignature(
            "getSettlementWindows(uint256)",
            marketId
        ));
        if (ret.length > 0) {
            (tSet, settleEnd, opsEnd, claimOpen) = abi.decode(ret, (uint64, uint64, uint64, uint64));
        }
    }

    function getSettlementPrice(uint256 marketId)
        external
        override
        returns (int256 price, uint64 priceTimestamp)
    {
        bytes memory ret = _delegateView(oracleModule, abi.encodeWithSignature(
            "getSettlementPrice(uint256)",
            marketId
        ));
        if (ret.length > 0) (price, priceTimestamp) = abi.decode(ret, (int256, uint64));
    }

    /// @notice Trigger settlement snapshot chunks after market settlement (owner/operator).
    function requestSettlementChunks(uint256 marketId, uint32 maxChunksPerTx)
        external
        override
        onlyOwnerOrOperator
        returns (uint32 emitted)
    {
        bytes memory ret = _delegate(lifecycleModule, abi.encodeWithSignature(
            "requestSettlementChunks(uint256,uint32)",
            marketId,
            maxChunksPerTx
        ));
        if (ret.length > 0) emitted = abi.decode(ret, (uint32));
    }

    // ============================================================
    // Vault entrypoints (delegate to LPVaultModule)
    // ============================================================

    function seedVault(uint256 seedAmount) external whenNotPaused nonReentrant {
        _delegate(vaultModule, abi.encodeWithSignature("seedVault(uint256)", seedAmount));
    }

    function requestDeposit(uint256 amount) external whenNotPaused nonReentrant returns (uint64 requestId) {
        bytes memory ret = _delegate(vaultModule, abi.encodeWithSignature("requestDeposit(uint256)", amount));
        if (ret.length > 0) requestId = abi.decode(ret, (uint64));
    }

    function requestWithdraw(uint256 shares) external whenNotPaused nonReentrant returns (uint64 requestId) {
        bytes memory ret = _delegate(vaultModule, abi.encodeWithSignature("requestWithdraw(uint256)", shares));
        if (ret.length > 0) requestId = abi.decode(ret, (uint64));
    }

    function cancelDeposit(uint64 requestId) external whenNotPaused nonReentrant {
        _delegate(vaultModule, abi.encodeWithSignature("cancelDeposit(uint64)", requestId));
    }

    function cancelWithdraw(uint64 requestId) external whenNotPaused nonReentrant {
        _delegate(vaultModule, abi.encodeWithSignature("cancelWithdraw(uint64)", requestId));
    }

    function processDailyBatch(uint64 batchId) external onlyOwnerOrOperator nonReentrant {
        _delegate(vaultModule, abi.encodeWithSignature("processDailyBatch(uint64)", batchId));
    }

    /// @notice Claim shares from processed deposit
    /// @dev Allowed even when paused - user funds should always be claimable after batch processing
    function claimDeposit(uint64 requestId) external nonReentrant returns (uint256 shares) {
        bytes memory ret = _delegate(vaultModule, abi.encodeWithSignature("claimDeposit(uint64)", requestId));
        if (ret.length > 0) shares = abi.decode(ret, (uint256));
    }

    /// @notice Claim assets from processed withdrawal
    /// @dev Allowed even when paused - user funds should always be claimable after batch processing
    function claimWithdraw(uint64 requestId) external nonReentrant returns (uint256 assets) {
        bytes memory ret = _delegate(vaultModule, abi.encodeWithSignature("claimWithdraw(uint64)", requestId));
        if (ret.length > 0) assets = abi.decode(ret, (uint256));
    }

    // ============================================================
    // Vault View Functions (direct storage read for ERC-4626)
    // ============================================================

    /// @notice Get current vault NAV
    function getVaultNav() external view returns (uint256) {
        return lpVault.nav;
    }

    /// @notice Get current vault total shares
    function getVaultShares() external view returns (uint256) {
        return lpVault.shares;
    }

    /// @notice Get current vault share price (P = N/S)
    function getVaultPrice() external view returns (uint256) {
        return lpVault.price;
    }

    /// @notice Check if vault is seeded
    function isVaultSeeded() external view returns (bool) {
        return lpVault.isSeeded;
    }

    /// @notice Get vault peak price
    function getVaultPricePeak() external view returns (uint256) {
        return lpVault.pricePeak;
    }

    /// @notice Get current vault peak drawdown
    /// @return drawdown Peak drawdown in WAD (0 = no drawdown, 1e18 = 100%)
    function getVaultDrawdown() external view returns (uint256 drawdown) {
        if (lpVault.pricePeak == 0 || lpVault.price >= lpVault.pricePeak) {
            return 0;
        }
        return WAD - (lpVault.price * WAD) / lpVault.pricePeak;
    }

    /// @notice Get current risk configuration
    function getRiskConfig() external view returns (
        uint256 lambda,
        uint256 kDrawdown,
        bool enforceAlpha
    ) {
        return (riskConfig.lambda, riskConfig.kDrawdown, riskConfig.enforceAlpha);
    }

    /// @notice Get fee waterfall configuration
    function getFeeWaterfallConfig() external view returns (
        uint256 rhoBS,
        int256 pdd,
        uint256 phiLP,
        uint256 phiBS,
        uint256 phiTR
    ) {
        return (
            feeWaterfallConfig.rhoBS,
            feeWaterfallConfig.pdd,
            feeWaterfallConfig.phiLP,
            feeWaterfallConfig.phiBS,
            feeWaterfallConfig.phiTR
        );
    }

    /// @notice Get capital stack state
    function getCapitalStack() external view returns (
        uint256 backstopNav,
        uint256 treasuryNav
    ) {
        return (capitalStack.backstopNav, capitalStack.treasuryNav);
    }

    /// @notice Get current batch ID
    function getCurrentBatchId() external view returns (uint64) {
        return currentBatchId;
    }

    /// @notice Get market counts for a batch (one-to-many)
    function getBatchMarketState(uint64 batchId) external view returns (uint64 total, uint64 resolved) {
        BatchMarketState storage state = _batchMarketState[batchId];
        return (state.total, state.resolved);
    }

    /// @notice Get withdrawal lag in batches
    function getWithdrawalLagBatches() external view returns (uint64) {
        return withdrawalLagBatches;
    }

    function getDailyPnl(uint64 batchId)
        external
        returns (
            int256 lt,
            uint256 ftot,
            uint256 ft,
            uint256 gt,
            uint256 npre,
            uint256 pe,
            bool processed
        )
    {
        bytes memory ret = _delegateView(vaultModule, abi.encodeWithSignature("getDailyPnl(uint64)", batchId));
        if (ret.length > 0) (lt, ftot, ft, gt, npre, pe, processed) = abi.decode(
            ret,
            (int256, uint256, uint256, uint256, uint256, uint256, bool)
        );
    }

    function _requireAddress(address value) internal pure {
        if (value == address(0)) revert IcicleOptionsErrors.ZeroAddress();
    }

    function _requireContract(address value) internal view {
        if (value.code.length == 0) revert IcicleOptionsErrors.ModuleNotSet();
    }

    // --- Internal: delegate helpers ---

    /// @dev Delegate to a module preserving context, bubble up revert
    function _delegate(address module, bytes memory callData) internal returns (bytes memory) {
        if (module == address(0)) revert IcicleOptionsErrors.ModuleNotSet();
        (bool success, bytes memory ret) = module.delegatecall(callData);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    /// @dev Delegate to a module for view-like paths; bubble up reverts.
    /// @notice Uses delegatecall to access storage in Core's context.
    function _delegateView(address module, bytes memory callData) internal returns (bytes memory) {
        if (module == address(0)) revert IcicleOptionsErrors.ModuleNotSet();
        (bool success, bytes memory ret) = module.delegatecall(callData);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    // ============================================================
    // Risk Gate Pattern
    // ============================================================

    /// @dev Execute risk gate via delegatecall, bubble up revert
    /// @param gateCalldata Encoded call to RiskModule gate function
    function _riskGate(bytes memory gateCalldata) internal {
        if (riskModule == address(0)) revert IcicleOptionsErrors.ModuleNotSet();
        (bool success, bytes memory ret) = riskModule.delegatecall(gateCalldata);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
