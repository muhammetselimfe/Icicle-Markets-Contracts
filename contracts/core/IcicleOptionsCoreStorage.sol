// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IIcicleOptionsCore.sol";
import "../interfaces/IIcicleOptionsPosition.sol";
import "../lib/LazyMulSegmentTree.sol";

abstract contract IcicleOptionsCoreStorage {
    // ============================================================
    // Events (Capital Stack Funding)
    // ============================================================
    event BackstopFunded(address indexed from, uint256 amount6, uint256 backstopNav);
    event BackstopWithdrawn(address indexed to, uint256 amount6, uint256 backstopNav);
    event TreasuryFunded(address indexed from, uint256 amount6, uint256 treasuryNav);
    event TreasuryWithdrawn(address indexed to, uint256 amount6, uint256 treasuryNav);

    /// @dev day boundary offset in seconds (multiple of common batch periods).
    uint64 internal constant BATCH_TIMEZONE_OFFSET = 28_800;
    // NOTE: configurable `batchSeconds` storage var is declared near __gap (append-only
    // for upgrade safety); 0 => 86400 (daily default).

    /// @dev Effective batch period; treats unset (0) as the 86400 daily default.
    function _period() internal view returns (uint64) {
        return batchSeconds == 0 ? 86_400 : batchSeconds;
    }

    function _toBatchId(uint64 timestamp) internal view returns (uint64) {
        if (timestamp < BATCH_TIMEZONE_OFFSET) {
            return 0;
        }
        return (timestamp - BATCH_TIMEZONE_OFFSET) / _period();
    }

    function _batchStartTimestamp(uint64 batchId) internal view returns (uint64) {
        return batchId * _period() + BATCH_TIMEZONE_OFFSET;
    }

    // ============================================================
    // Settlement Timeline Configuration
    // ============================================================
    // Timeline: Trading → SettlementOpen → PendingOps → Finalized
    // 
    // settlementSubmitWindow (Δsettle): [Tset, Tset + Δsettle) = SettlementOpen
    //   - Anyone can submit oracle samples during this window
    // pendingOpsWindow (Δops): [Tset + Δsettle, Tset + Δsettle + Δops) = PendingOps
    //   - No new samples; ops can mark failed or finalize
    // After Tset + Δsettle: finalizePrimary() is callable (during or after PendingOps)
    //
    // Δclaim invariant: claimDelaySeconds = settlementSubmitWindow + pendingOpsWindow
    // Claims open at Tset + Δclaim (finalization still required)

    /// @notice Δsettle: Duration of SettlementOpen window (seconds)
    /// @dev Anyone can submit oracle samples during [Tset, Tset + settlementSubmitWindow)
    uint64 public settlementSubmitWindow;
    
    /// @notice Δclaim: Delay before claims open after Tset (seconds)
    /// @dev Claims open at settlementTimestamp + claimDelaySeconds
    uint64 public claimDelaySeconds;
    
    /// @notice Δops: Duration of PendingOps window (seconds)
    /// @dev Operations can mark failed during [Tset + Δsettle, Tset + Δsettle + Δops)
    uint64 public pendingOpsWindow;
    
    /// @notice Δmax: Maximum allowed |priceTimestamp - Tset| for samples (seconds)
    /// @dev Samples with distance > maxSampleDistance are rejected
    uint64 public maxSampleDistance;
    
    /// @notice δfuture: Future tolerance for price timestamps (seconds, default 0)
    /// @dev Samples with priceTimestamp > block.timestamp + futureTolerance are rejected
    uint64 public futureTolerance;
    
    /// @notice Redstone data feed ID (e.g., bytes32("BTC"))
    bytes32 public redstoneFeedId;
    
    /// @notice Redstone feed decimals (e.g., 8 for BTC/USD)
    uint8 public redstoneFeedDecimals;

    // ============================================================
    // Operator Access Control
    // ============================================================
    /// @notice Operator allowlist for automation.
    mapping(address => bool) internal _operators;

    IERC20 public paymentToken;
    IIcicleOptionsPosition public positionContract;
    
    /// @notice LP Share token (ERC-4626 compatible)
    address public lpShareToken;

    mapping(uint256 => IIcicleOptionsCore.Market) public markets;
    mapping(uint256 => LazyMulSegmentTree.Tree) public marketTrees;
    uint256 public nextMarketId;

    struct SettlementOracleState {
        int256 candidateValue;
        uint64 candidatePriceTimestamp;
    }

    mapping(uint256 => SettlementOracleState) internal settlementOracleState;

    mapping(uint256 => bool) public positionSettledEmitted;

    // ============================================================
    // LP Vault State
    // ============================================================
    
    /// @notice LP Vault accounting state
    struct VaultState {
        uint256 nav;           // N_t: current NAV (WAD)
        uint256 shares;        // S_t: current total shares (WAD)
        uint256 price;         // P_t: current price (WAD)
        uint256 pricePeak;     // P^peak_t: running peak price (WAD)
        uint64 lastBatchTimestamp; // Timestamp of last batch
        bool isSeeded;         // Has vault been seeded
    }
    
    VaultState internal lpVault;

    // ============================================================
    // Fee Waterfall & Capital Stack
    // ============================================================

    /// @notice Capital stack configuration (Backstop + Treasury)
    struct CapitalStackState {
        uint256 backstopNav;     // B_t: Backstop NAV (WAD)
        uint256 treasuryNav;     // T_t: Treasury NAV (WAD)
    }

    /// @notice Fee waterfall configuration parameters
    struct FeeWaterfallConfig {
        int256 pdd;              // NAV loss floor (negative WAD, pdd := -lambda, e.g., -0.3e18 = -30%)
        uint256 rhoBS;           // ρ_BS: Backstop coverage target ratio (WAD)
        uint256 phiLP;           // ϕ_LP: LP residual fee share (WAD)
        uint256 phiBS;           // ϕ_BS: Backstop residual fee share (WAD)
        uint256 phiTR;           // ϕ_TR: Treasury residual fee share (WAD)
        // NOTE: ΔEₜ is now stored per-market in Market.deltaEt and summed per-batch
        //       in DailyPnlSnapshot.DeltaEtSum. Global config field removed.
    }

    /// @notice Daily P&L snapshot for batch processing
    struct DailyPnlSnapshot {
        // Input values
        int256 Lt;               // CLMSR P&L (signed)
        uint256 Ftot;            // Total gross fees
        uint256 DeltaEtSum;      // Sum of ΔEₜ from all settled markets in this batch
        
        // Fee Waterfall intermediate values
        uint256 Floss;           // Loss compensation: min(Ftot, |L^-|)
        uint256 Fpool;           // Remaining pool: Ftot - Floss
        uint256 Nraw;            // NAV after loss comp: N_{t-1} + Lt + Floss
        uint256 Gt;              // Grant from Backstop
        uint256 Ffill;           // Backstop coverage fill
        
        // Fee splits
        uint256 FLP;             // Fee to LP: Floss + F_core_LP + dust
        uint256 FBS;             // Fee to Backstop: F_fill + F_core_BS
        uint256 FTR;             // Fee to Treasury: F_core_TR
        uint256 Fdust;           // Rounding dust (to LP)
        
        // Output values
        uint256 Ft;              // Total fee credited to LP NAV
        uint256 Npre;            // Pre-batch NAV
        uint256 Pe;              // Batch equity price: Npre / S_{t-1}
        
        // State
        bool processed;          // Whether this batch has been processed
    }

    /// @notice Unified capital stack state
    CapitalStackState internal capitalStack;

    /// @notice Fee waterfall configuration
    FeeWaterfallConfig internal feeWaterfallConfig;

    /// @notice Daily P&L snapshots by batch ID
    mapping(uint64 => DailyPnlSnapshot) internal _dailyPnl;

    // ============================================================
    // Request ID-based Queue
    // ============================================================

    /// @notice Request status enum for ID-based queue
    enum RequestStatus {
        Pending,
        Processed,
        Claimed,
        Cancelled
    }

    /// @notice Deposit request with ID
    struct DepositRequest {
        uint64 id;
        address owner;
        uint256 amount;
        uint64 eligibleBatchId;
        RequestStatus status;
    }

    /// @notice Withdraw request with ID
    struct WithdrawRequest {
        uint64 id;
        address owner;
        uint256 shares;
        uint64 eligibleBatchId;
        RequestStatus status;
    }

    /// @notice Batch aggregation result
    struct BatchAggregation {
        uint256 totalDepositAssets;   // Sum of all eligible deposit amounts
        uint256 totalWithdrawShares;  // Sum of all eligible withdraw shares
        uint256 batchPrice;           // P^e_t used for this batch
        bool processed;               // Whether batch has been processed
    }

    /// @notice Pending aggregation for batch (pre-processing)
    struct PendingBatchTotal {
        uint256 deposits;    // Sum of pending deposit amounts for this batch
        uint256 withdraws;   // Sum of pending withdraw shares for this batch
    }

    // ============================================================
    // Request ID-based Queue Storage
    // ============================================================

    /// @notice Request ID → DepositRequest mapping
    mapping(uint64 => DepositRequest) internal _depositRequests;

    /// @notice Request ID → WithdrawRequest mapping
    mapping(uint64 => WithdrawRequest) internal _withdrawRequests;

    /// @notice Batch ID → Aggregation result (post-processing)
    mapping(uint64 => BatchAggregation) internal _batchAggregations;

    /// @notice Batch ID → Pending totals (pre-processing)
    /// @dev Used for O(1) batch processing: totals are pre-aggregated on request
    mapping(uint64 => PendingBatchTotal) internal _pendingBatchTotals;

    /// @notice Next deposit request ID
    uint64 public nextDepositRequestId;

    /// @notice Next withdraw request ID
    uint64 public nextWithdrawRequestId;

    /// @notice Current batch ID (increments on each batch)
    uint64 public currentBatchId;

    /// @notice Withdrawal lag in batches (D_lag)
    /// @dev Request made at batch N is eligible at batch N + withdrawalLagBatches
    uint64 public withdrawalLagBatches;

    // ============================================================
    // Exposure Ledger & Payout Reserve
    // ============================================================

    /// @notice Market ID → Diff array for exposure tracking (bin-based)
    /// @dev Exposure Ledger Q_t: tracks payout liability per settlement bin
    ///      Uses diff-array pattern:
    ///      - rangeAdd([loBin, hiBin], delta): O(1) - 2 SSTOREs
    ///      - pointQuery(bin): O(n) - prefix sum over [0..bin]
    ///      Index is 0-based: diff[0..numBins-1]
    ///      Signed int256 to support both positive and negative deltas
    mapping(uint256 => mapping(uint32 => int256)) internal _exposureDiff;

    /// @notice Market ID → payout reserve (escrow) for settled markets
    /// @dev Set at settleMarket time, equals Q_{τ_t} (exposure at settlement tick)
    ///      Subsequent claims draw from this reserve without affecting NAV
    mapping(uint256 => uint256) internal _payoutReserve;

    /// @notice Market ID → remaining payout reserve (decremented on each claim)
    mapping(uint256 => uint256) internal _payoutReserveRemaining;

    // ============================================================
    // Free Balance Accounting (Escrow Safety)
    // ============================================================

    /// @notice Total pending deposits in 6-decimal token units
    /// @dev Incremented on requestDeposit, decremented on cancelDeposit or processDailyBatch
    ///      Used for free balance calculation to ensure deposit funds are isolated
    uint256 internal _totalPendingDeposits6;

    /// @notice Total payout reserve in 6-decimal token units
    /// @dev Sum of all _payoutReserveRemaining across all markets
    ///      Incremented at settlement, decremented on claimPayout
    uint256 internal _totalPayoutReserve6;

    /// @notice Total pending withdrawals in 6-decimal token units
    /// @dev Incremented at processDailyBatch when withdrawals are processed,
    ///      decremented on claimWithdraw. Ensures withdrawal funds are reserved
    ///      and cannot be used for other payments (payout claims, transfers, etc.)
    uint256 internal _totalPendingWithdrawals6;

    // ============================================================
    // Risk Configuration
    // ============================================================

    /// @notice Risk parameters for α Safety Bounds
    struct RiskConfig {
        uint256 lambda;      // λ: NAV loss limit per batch (WAD); sets pdd := -lambda
        uint256 kDrawdown;   // k: Peak drawdown sensitivity for alpha limit (WAD)
        bool enforceAlpha;   // Whether to enforce α bounds at market creation time
    }

    /// @notice Risk configuration
    RiskConfig internal riskConfig;

    /// @notice Batch market counts (one-to-many)
    struct BatchMarketState {
        uint64 total;    // Total markets assigned to this batch
        uint64 resolved; // Markets that are settled or failed
    }

    /// @notice Batch ID → market counts
    mapping(uint64 => BatchMarketState) internal _batchMarketState;

    /// @notice Market ID → batch resolution flag (prevents double-counting)
    mapping(uint256 => bool) internal _marketBatchResolved;

    /// @dev Configurable batch accounting period (seconds); 0 => 86400 daily default.
    ///      Appended here (not at the top) so the layout stays append-only / upgrade-safe.
    uint64 public batchSeconds;

    // Reserve ample slots for future upgrades; do not change after first deployment.
    uint256[11] internal __gap;
}
