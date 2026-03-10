// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/Create2.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../errors/IcicleOptionsErrors.sol";
import "../core/IcicleOptionsCore.sol";
import "../position/IcicleOptionsPosition.sol";
import "../tokens/IcicleOptionsLPShare.sol";

/// @notice Deterministic one-shot deployer for Core/Position/LPShare proxies.
contract IcicleOptionsDeployer is IcicleOptionsErrors {
    address public immutable deployerEOA;
    bool public executed;

    modifier onlyDeployer() {
        if (msg.sender != deployerEOA) revert UnauthorizedCaller(msg.sender);
        _;
    }

    constructor(address deployerEOA_) {
        if (deployerEOA_ == address(0)) revert ZeroAddress();
        deployerEOA = deployerEOA_;
    }

    function deployAllDeterministic(
        address coreImpl,
        address positionImpl,
        address lpShareImpl,
        bytes32 coreSalt,
        bytes32 positionSalt,
        bytes32 lpShareSalt,
        address expectedCoreProxy,
        address expectedPositionProxy,
        address expectedLpShareProxy,
        IcicleOptionsCore.InitParams calldata coreParams,
        string calldata lpShareName,
        string calldata lpShareSymbol
    ) external onlyDeployer returns (address coreProxy, address positionProxy, address lpShareProxy) {
        if (executed) revert DeploymentAlreadyExecuted();

        _requireAddress(coreImpl);
        _requireAddress(positionImpl);
        _requireAddress(lpShareImpl);
        _requireAddress(expectedCoreProxy);
        _requireAddress(expectedPositionProxy);
        _requireAddress(expectedLpShareProxy);
        _requireContract(coreImpl);
        _requireContract(positionImpl);
        _requireContract(lpShareImpl);

        bytes memory coreInitCode = _proxyInitCode(coreImpl);
        bytes memory positionInitCode = _proxyInitCode(positionImpl);
        bytes memory lpShareInitCode = _proxyInitCode(lpShareImpl);

        address predictedCore = Create2.computeAddress(coreSalt, keccak256(coreInitCode), address(this));
        address predictedPosition = Create2.computeAddress(positionSalt, keccak256(positionInitCode), address(this));
        address predictedLpShare = Create2.computeAddress(lpShareSalt, keccak256(lpShareInitCode), address(this));

        if (predictedCore != expectedCoreProxy) {
            revert Create2AddressMismatch(expectedCoreProxy, predictedCore);
        }
        if (predictedPosition != expectedPositionProxy) {
            revert Create2AddressMismatch(expectedPositionProxy, predictedPosition);
        }
        if (predictedLpShare != expectedLpShareProxy) {
            revert Create2AddressMismatch(expectedLpShareProxy, predictedLpShare);
        }

        coreProxy = Create2.deploy(0, coreSalt, coreInitCode);
        positionProxy = Create2.deploy(0, positionSalt, positionInitCode);
        lpShareProxy = Create2.deploy(0, lpShareSalt, lpShareInitCode);

        if (coreParams.positionContract != positionProxy) {
            revert Create2AddressMismatch(coreParams.positionContract, positionProxy);
        }
        if (coreParams.lpShareToken != lpShareProxy) {
            revert Create2AddressMismatch(coreParams.lpShareToken, lpShareProxy);
        }

        IcicleOptionsCore(coreProxy).initialize(coreParams);
        IcicleOptionsPosition(positionProxy).initialize(coreProxy, coreParams.ownerSafe);
        IcicleOptionsLPShare(lpShareProxy).initialize(
            coreProxy,
            coreParams.paymentToken,
            lpShareName,
            lpShareSymbol,
            coreParams.ownerSafe
        );

        if (IcicleOptionsCore(coreProxy).owner() != coreParams.ownerSafe) {
            revert Create2AddressMismatch(coreParams.ownerSafe, IcicleOptionsCore(coreProxy).owner());
        }
        if (IcicleOptionsPosition(positionProxy).owner() != coreParams.ownerSafe) {
            revert Create2AddressMismatch(coreParams.ownerSafe, IcicleOptionsPosition(positionProxy).owner());
        }
        if (IcicleOptionsLPShare(lpShareProxy).owner() != coreParams.ownerSafe) {
            revert Create2AddressMismatch(coreParams.ownerSafe, IcicleOptionsLPShare(lpShareProxy).owner());
        }
        address paymentToken = address(IcicleOptionsCore(coreProxy).paymentToken());
        if (paymentToken != coreParams.paymentToken) {
            revert Create2AddressMismatch(coreParams.paymentToken, paymentToken);
        }
        address positionContract = address(IcicleOptionsCore(coreProxy).positionContract());
        if (positionContract != positionProxy) {
            revert Create2AddressMismatch(positionProxy, positionContract);
        }
        if (IcicleOptionsCore(coreProxy).lpShareToken() != lpShareProxy) {
            revert Create2AddressMismatch(lpShareProxy, IcicleOptionsCore(coreProxy).lpShareToken());
        }
        if (IcicleOptionsCore(coreProxy).tradeModule() != coreParams.tradeModule) {
            revert Create2AddressMismatch(coreParams.tradeModule, IcicleOptionsCore(coreProxy).tradeModule());
        }
        if (IcicleOptionsCore(coreProxy).lifecycleModule() != coreParams.lifecycleModule) {
            revert Create2AddressMismatch(coreParams.lifecycleModule, IcicleOptionsCore(coreProxy).lifecycleModule());
        }
        if (IcicleOptionsCore(coreProxy).riskModule() != coreParams.riskModule) {
            revert Create2AddressMismatch(coreParams.riskModule, IcicleOptionsCore(coreProxy).riskModule());
        }
        if (IcicleOptionsCore(coreProxy).vaultModule() != coreParams.vaultModule) {
            revert Create2AddressMismatch(coreParams.vaultModule, IcicleOptionsCore(coreProxy).vaultModule());
        }
        if (IcicleOptionsCore(coreProxy).oracleModule() != coreParams.oracleModule) {
            revert Create2AddressMismatch(coreParams.oracleModule, IcicleOptionsCore(coreProxy).oracleModule());
        }
        if (IcicleOptionsPosition(positionProxy).core() != coreProxy) {
            revert Create2AddressMismatch(coreProxy, IcicleOptionsPosition(positionProxy).core());
        }
        if (IcicleOptionsLPShare(lpShareProxy).core() != coreProxy) {
            revert Create2AddressMismatch(coreProxy, IcicleOptionsLPShare(lpShareProxy).core());
        }

        executed = true;
    }

    function _proxyInitCode(address impl) internal pure returns (bytes memory) {
        return abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(impl, ""));
    }

    function _requireAddress(address value) internal pure {
        if (value == address(0)) revert ZeroAddress();
    }

    function _requireContract(address value) internal view {
        if (value.code.length == 0) revert ModuleNotSet();
    }
}
