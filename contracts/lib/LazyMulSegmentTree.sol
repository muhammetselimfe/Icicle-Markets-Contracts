// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IcicleOptionsErrors as SE} from "../errors/IcicleOptionsErrors.sol";

/// @title LazyMulSegmentTree
/// @notice Sparse lazy multiplication segment tree for CLMSR tick data.
/// @dev Default value for all leaves is 1 WAD; nodes are allocated on demand.
library LazyMulSegmentTree {
    uint256 public constant ONE_WAD = 1e18;
    uint256 private constant HALF_WAD = 5e17;
    uint256 public constant MIN_FACTOR = 0.01e18;
    uint256 public constant MAX_FACTOR = 100e18;
    uint256 public constant FLUSH_THRESHOLD = 1e21;
    uint256 public constant UNDERFLOW_FLUSH_THRESHOLD = 1e15;

    struct Node {
        uint256 sum;
        uint192 pendingFactor;
        uint64 childPtr; // left(32) | right(32)
    }

    struct Tree {
        mapping(uint32 => Node) nodes;
        uint32 root;
        uint32 nextIndex;
        uint32 size;
        uint256 cachedRootSum;
    }

    // ============================================================
    // External-style API
    // ============================================================

    function init(Tree storage tree, uint32 treeSize) external {
        if (treeSize == 0) revert SE.TreeSizeZero();
        if (tree.size != 0) revert SE.TreeAlreadyInitialized();
        if (treeSize > type(uint32).max / 2) revert SE.TreeSizeTooLarge();

        tree.size = treeSize;
        tree.nextIndex = 0;
        tree.root = _allocateNode(tree, 0, treeSize - 1);
        tree.cachedRootSum = tree.nodes[tree.root].sum;
    }

    function applyRangeFactor(Tree storage tree, uint32 lo, uint32 hi, uint256 factor) external {
        if (tree.size == 0) revert SE.TreeNotInitialized();
        if (lo > hi) revert SE.InvalidRange(lo, hi);
        if (hi >= tree.size) revert SE.IndexOutOfBounds(hi, tree.size);
        if (factor < MIN_FACTOR || factor > MAX_FACTOR) revert SE.InvalidFactor(factor);

        _applyFactorRecursive(tree, tree.root, 0, tree.size - 1, lo, hi, factor);
    }

    function getRangeSum(Tree storage tree, uint32 lo, uint32 hi) external view returns (uint256 sum) {
        if (tree.size == 0) revert SE.TreeNotInitialized();
        if (lo > hi) revert SE.InvalidRange(lo, hi);
        if (hi >= tree.size) revert SE.IndexOutOfBounds(hi, tree.size);

        return _sumRangeWithAccFactor(tree, tree.root, 0, tree.size - 1, lo, hi, ONE_WAD);
    }

    function propagateLazy(Tree storage tree, uint32 lo, uint32 hi) external returns (uint256 sum) {
        if (tree.size == 0) revert SE.TreeNotInitialized();
        if (lo > hi) revert SE.InvalidRange(lo, hi);
        if (hi >= tree.size) revert SE.IndexOutOfBounds(hi, tree.size);

        return _queryRecursive(tree, tree.root, 0, tree.size - 1, lo, hi);
    }

    function totalSum(Tree storage tree) internal view returns (uint256) {
        if (tree.size == 0) revert SE.TreeNotInitialized();
        return tree.cachedRootSum;
    }

    function seedWithFactors(Tree storage tree, uint256[] memory factors) internal {
        if (tree.size == 0) revert SE.TreeNotInitialized();
        if (factors.length != tree.size) revert SE.ArrayLengthMismatch();

        tree.nextIndex = 0;
        tree.root = 0;

        (uint32 rootIndex, uint256 total) = _buildTreeFromArray(tree, 0, tree.size - 1, factors);
        tree.root = rootIndex;
        tree.cachedRootSum = total;
    }

    // ============================================================
    // Internal helpers
    // ============================================================

    function _defaultSum(uint32 l, uint32 r) private pure returns (uint256 sum) {
        unchecked {
            return uint256(r - l + 1) * ONE_WAD;
        }
    }

    function _mulWithCompensation(uint256 value, uint256 factor) private pure returns (uint256) {
        if (value == 0 || factor == ONE_WAD) {
            return value;
        }
        return _wMulNearestChecked(value, factor);
    }

    function _combineFactors(uint256 lhs, uint256 rhs) private pure returns (uint256) {
        if (rhs == ONE_WAD) {
            return lhs;
        }

        return _wMulNearestChecked(lhs, rhs);
    }

    function _wMulNearestChecked(uint256 x, uint256 y) private pure returns (uint256 result) {
        if (x == 0 || y == 0) {
            return 0;
        }

        // Math.mulDiv(x, y, WAD) panics when y > WAD and x is too large.
        // Bound x first so every overflow path maps to MathMulOverflow.
        if (y > ONE_WAD) {
            uint256 maxInput = Math.mulDiv(type(uint256).max, ONE_WAD, y);
            if (x > maxInput) revert SE.MathMulOverflow();
        }

        result = Math.mulDiv(x, y, ONE_WAD);
        uint256 remainder = mulmod(x, y, ONE_WAD);
        if (remainder >= HALF_WAD) {
            if (result == type(uint256).max) revert SE.MathMulOverflow();
            unchecked {
                result += 1;
            }
        }
    }

    function _addOrRevert(uint256 lhs, uint256 rhs) private pure returns (uint256 sum) {
        unchecked {
            sum = lhs + rhs;
        }
        if (sum < lhs) revert SE.MathMulOverflow();
    }

    function _packChildPtr(uint32 left, uint32 right) private pure returns (uint64) {
        return (uint64(left) << 32) | uint64(right);
    }

    function _unpackChildPtr(uint64 packed) private pure returns (uint32 left, uint32 right) {
        left = uint32(packed >> 32);
        right = uint32(packed);
    }

    function _allocateNode(Tree storage tree, uint32 l, uint32 r) private returns (uint32 newIndex) {
        newIndex = ++tree.nextIndex;
        Node storage node = tree.nodes[newIndex];
        node.pendingFactor = uint192(ONE_WAD);
        node.sum = _defaultSum(l, r);
    }

    function _scaleNodeSum(Node storage node, uint256 factor) private {
        node.sum = _mulWithCompensation(node.sum, factor);
    }

    function _applyFactorToNode(Tree storage tree, uint32 nodeIndex, uint256 factor) private {
        if (nodeIndex == 0 || factor == ONE_WAD) return;

        Node storage node = tree.nodes[nodeIndex];
        _scaleNodeSum(node, factor);

        uint256 priorPending = uint256(node.pendingFactor);
        uint256 newPendingFactor = _combineFactors(priorPending, factor);

        if (newPendingFactor > type(uint192).max) revert SE.LazyFactorOverflow();
        node.pendingFactor = uint192(newPendingFactor);

        if (nodeIndex == tree.root) {
            tree.cachedRootSum = node.sum;
        }
    }

    function _pushPendingFactor(Tree storage tree, uint32 nodeIndex, uint32 l, uint32 r) private {
        if (nodeIndex == 0) return;

        Node storage node = tree.nodes[nodeIndex];
        uint192 nodePendingFactor = node.pendingFactor;

        if (nodePendingFactor != uint192(ONE_WAD)) {
            uint32 mid = l + (r - l) / 2;
            (uint32 left, uint32 right) = _unpackChildPtr(node.childPtr);

            uint256 pendingFactorVal = uint256(nodePendingFactor);

            if (left == 0) {
                left = _allocateNode(tree, l, mid);
            }
            if (right == 0) {
                right = _allocateNode(tree, mid + 1, r);
            }

            _applyFactorToNode(tree, left, pendingFactorVal);
            _applyFactorToNode(tree, right, pendingFactorVal);

            node.childPtr = _packChildPtr(left, right);
            node.pendingFactor = uint192(ONE_WAD);

            _pullUpSum(tree, nodeIndex, l, r);
        }
    }

    function _rebalanceChildren(
        Tree storage tree,
        uint32 left,
        uint32 right,
        uint256 target
    ) private {
        uint256 combined = _addOrRevert(tree.nodes[left].sum, tree.nodes[right].sum);
        if (combined == target) return;

        if (combined < target) {
            tree.nodes[right].sum = _addOrRevert(tree.nodes[right].sum, target - combined);
            return;
        }

        uint256 surplus = combined - target;
        uint256 rightSum = tree.nodes[right].sum;
        if (surplus <= rightSum) {
            tree.nodes[right].sum = rightSum - surplus;
            return;
        }

        uint256 remaining = surplus - rightSum;
        tree.nodes[right].sum = 0;
        uint256 leftSum = tree.nodes[left].sum;
        if (remaining > leftSum) revert SE.MathMulOverflow();
        tree.nodes[left].sum = leftSum - remaining;
    }

    function _pullUpSum(Tree storage tree, uint32 nodeIndex, uint32 l, uint32 r) private {
        if (nodeIndex == 0) return;

        Node storage node = tree.nodes[nodeIndex];
        (uint32 left, uint32 right) = _unpackChildPtr(node.childPtr);

        uint32 mid = l + (r - l) / 2;

        uint256 leftSum = (left != 0) ? tree.nodes[left].sum : _defaultSum(l, mid);
        uint256 rightSum = (right != 0) ? tree.nodes[right].sum : _defaultSum(mid + 1, r);

        node.sum = _addOrRevert(leftSum, rightSum);

        if (nodeIndex == tree.root) {
            tree.cachedRootSum = node.sum;
        }
    }

    function _applyFactorRecursive(
        Tree storage tree,
        uint32 nodeIndex,
        uint32 l,
        uint32 r,
        uint32 lo,
        uint32 hi,
        uint256 factor
    ) private {
        if (r < lo || l > hi) return;
        if (nodeIndex == 0) return;

        Node storage node = tree.nodes[nodeIndex];

        if (l >= lo && r <= hi) {
            uint256 priorPending = uint256(node.pendingFactor);
            uint256 combinedPending = _combineFactors(priorPending, factor);

            if (
                priorPending != ONE_WAD &&
                (combinedPending < UNDERFLOW_FLUSH_THRESHOLD || combinedPending > FLUSH_THRESHOLD)
            ) {
                _pushPendingFactor(tree, nodeIndex, l, r);
                priorPending = uint256(node.pendingFactor);
            }

            _scaleNodeSum(node, factor);

            uint256 newPendingFactor = _combineFactors(priorPending, factor);

            if (newPendingFactor < UNDERFLOW_FLUSH_THRESHOLD) {
                node.pendingFactor = uint192(factor);
            } else if (newPendingFactor > FLUSH_THRESHOLD) {
                node.pendingFactor = uint192(factor);
                _pushPendingFactor(tree, nodeIndex, l, r);
                node.pendingFactor = uint192(ONE_WAD);
            } else {
                if (newPendingFactor > type(uint192).max) revert SE.LazyFactorOverflow();
                node.pendingFactor = uint192(newPendingFactor);
            }

            if (nodeIndex == tree.root) {
                tree.cachedRootSum = node.sum;
            }
            return;
        }

        _pushPendingFactor(tree, nodeIndex, l, r);

        Node storage current = tree.nodes[nodeIndex];
        (uint32 leftChild, uint32 rightChild) = _unpackChildPtr(current.childPtr);
        uint32 mid = l + (r - l) / 2;

        if (lo <= mid) {
            if (leftChild == 0) {
                leftChild = _allocateNode(tree, l, mid);
            }
            _applyFactorRecursive(tree, leftChild, l, mid, lo, hi, factor);
        }
        if (hi > mid) {
            if (rightChild == 0) {
                rightChild = _allocateNode(tree, mid + 1, r);
            }
            _applyFactorRecursive(tree, rightChild, mid + 1, r, lo, hi, factor);
        }

        current.childPtr = _packChildPtr(leftChild, rightChild);

        uint256 leftSum = (leftChild != 0)
            ? tree.nodes[leftChild].sum
            : _defaultSum(l, mid);
        uint256 rightSum = (rightChild != 0)
            ? tree.nodes[rightChild].sum
            : _defaultSum(mid + 1, r);
        current.sum = _addOrRevert(leftSum, rightSum);

        if (nodeIndex == tree.root) {
            tree.cachedRootSum = current.sum;
        }
    }

    function _sumRangeWithAccFactor(
        Tree storage tree,
        uint32 nodeIndex,
        uint32 l,
        uint32 r,
        uint32 lo,
        uint32 hi,
        uint256 accFactor
    ) private view returns (uint256 sum) {
        if (nodeIndex == 0) {
            if (r < lo || l > hi) return 0;
            uint32 overlapL = lo > l ? lo : l;
            uint32 overlapR = hi < r ? hi : r;
            return _mulWithCompensation(_defaultSum(overlapL, overlapR), accFactor);
        }

        if (r < lo || l > hi) return 0;

        Node storage node = tree.nodes[nodeIndex];
        if (l >= lo && r <= hi) {
            return _mulWithCompensation(node.sum, accFactor);
        }

        uint256 newAccFactor = _wMulNearestChecked(accFactor, uint256(node.pendingFactor));
        uint32 mid = l + (r - l) / 2;
        (uint32 leftChild, uint32 rightChild) = _unpackChildPtr(node.childPtr);

        uint256 leftSum = _sumRangeWithAccFactor(tree, leftChild, l, mid, lo, hi, newAccFactor);
        uint256 rightSum = _sumRangeWithAccFactor(tree, rightChild, mid + 1, r, lo, hi, newAccFactor);

        return _addOrRevert(leftSum, rightSum);
    }

    function _queryRecursive(
        Tree storage tree,
        uint32 nodeIndex,
        uint32 l,
        uint32 r,
        uint32 lo,
        uint32 hi
    ) private returns (uint256 sum) {
        if (nodeIndex == 0) {
            if (r < lo || l > hi) return 0;
            uint32 overlapL = lo > l ? lo : l;
            uint32 overlapR = hi < r ? hi : r;
            return _defaultSum(overlapL, overlapR);
        }

        if (r < lo || l > hi) return 0;

        Node storage node = tree.nodes[nodeIndex];
        if (l >= lo && r <= hi) {
            return node.sum;
        }

        _pushPendingFactor(tree, nodeIndex, l, r);

        uint32 mid = l + (r - l) / 2;
        (uint32 leftChild, uint32 rightChild) = _unpackChildPtr(node.childPtr);

        uint256 leftSum = _queryRecursive(tree, leftChild, l, mid, lo, hi);
        uint256 rightSum = _queryRecursive(tree, rightChild, mid + 1, r, lo, hi);

        return _addOrRevert(leftSum, rightSum);
    }

    function _buildTreeFromArray(
        Tree storage tree,
        uint32 l,
        uint32 r,
        uint256[] memory factors
    ) private returns (uint32 nodeIndex, uint256 sum) {
        nodeIndex = _allocateNode(tree, l, r);
        Node storage node = tree.nodes[nodeIndex];
        node.pendingFactor = uint192(ONE_WAD);

        if (l == r) {
            uint256 leafValue = factors[uint256(l)];
            node.sum = leafValue;
            node.childPtr = 0;
            return (nodeIndex, leafValue);
        }

        uint32 mid = l + (r - l) / 2;
        (uint32 leftChild, uint256 leftSum) = _buildTreeFromArray(tree, l, mid, factors);
        (uint32 rightChild, uint256 rightSum) = _buildTreeFromArray(tree, mid + 1, r, factors);

        node.childPtr = _packChildPtr(leftChild, rightChild);
        uint256 total = _addOrRevert(leftSum, rightSum);
        node.sum = total;

        return (nodeIndex, total);
    }
}
