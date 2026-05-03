import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { verifyMerkleProof } from '../src/merkle.js';

// Build a minimal Merkle tree using the same algorithm as RootPay.sol.
// Leaf(i) = keccak256(abi.encode(i, secret_i))
// Node     = keccak256(abi.encode(left, right))
const coder = ethers.AbiCoder.defaultAbiCoder();

function leaf(index: number, secret: string): string {
  return ethers.keccak256(coder.encode(['uint16', 'bytes32'], [index, secret]));
}

function node(left: string, right: string): string {
  return ethers.keccak256(coder.encode(['bytes32', 'bytes32'], [left, right]));
}

// treeSize=2  →  root = node(leaf0, leaf1)
const S0 = '0x' + '00'.repeat(31) + '01';
const S1 = '0x' + '00'.repeat(31) + '02';
const L0 = leaf(0, S0);
const L1 = leaf(1, S1);
const ROOT2 = node(L0, L1);

// treeSize=4  →  two levels above leaves
const S2 = '0x' + '00'.repeat(31) + '03';
const S3 = '0x' + '00'.repeat(31) + '04';
const L2 = leaf(2, S2);
const L3 = leaf(3, S3);
const N01 = node(L0, L1);
const N23 = node(L2, L3);
const ROOT4 = node(N01, N23);

describe('verifyMerkleProof — treeSize=2', () => {
  test('valid proof for leaf 0', () => {
    // Leaf 0 is left child → sibling is L1
    assert.ok(verifyMerkleProof(ROOT2, 0, S0, [L1]));
  });

  test('valid proof for leaf 1', () => {
    // Leaf 1 is right child → sibling is L0
    assert.ok(verifyMerkleProof(ROOT2, 1, S1, [L0]));
  });

  test('wrong secret → false', () => {
    assert.ok(!verifyMerkleProof(ROOT2, 0, S1, [L1]));
  });

  test('wrong sibling → false', () => {
    assert.ok(!verifyMerkleProof(ROOT2, 0, S0, [L0])); // L0 instead of L1
  });

  test('wrong root → false', () => {
    const fakeRoot = '0x' + 'ff'.repeat(32);
    assert.ok(!verifyMerkleProof(fakeRoot, 0, S0, [L1]));
  });
});

describe('verifyMerkleProof — treeSize=4', () => {
  test('valid proof for leaf 0  (left-left path)', () => {
    // idx=0 (even) → concat(L0, L1), idx=0 (even) → concat(N01, N23)
    assert.ok(verifyMerkleProof(ROOT4, 0, S0, [L1, N23]));
  });

  test('valid proof for leaf 1  (right-left path)', () => {
    // idx=1 (odd)  → concat(L0, L1), idx=0 (even) → concat(N01, N23)
    assert.ok(verifyMerkleProof(ROOT4, 1, S1, [L0, N23]));
  });

  test('valid proof for leaf 2  (left-right path)', () => {
    // idx=2 (even) → concat(L2, L3), idx=1 (odd)  → concat(N01, N23)
    assert.ok(verifyMerkleProof(ROOT4, 2, S2, [L3, N01]));
  });

  test('valid proof for leaf 3  (right-right path)', () => {
    // idx=3 (odd)  → concat(L2, L3), idx=1 (odd)  → concat(N01, N23)
    assert.ok(verifyMerkleProof(ROOT4, 3, S3, [L2, N01]));
  });

  test('swapped sibling order → false', () => {
    assert.ok(!verifyMerkleProof(ROOT4, 0, S0, [N23, L1])); // proof elements in wrong order
  });
});
