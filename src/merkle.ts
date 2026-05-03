import { ethers } from 'ethers';

const coder = ethers.AbiCoder.defaultAbiCoder();

// Mirrors RootPay.sol exactly:
//   computeLeaf:      keccak256(abi.encode(leafIndex, secret))
//   verifyMerkleProof: keccak256(abi.encode(left, right))  — NOT encodePacked

function computeLeaf(leafIndex: number, secret: string): string {
  return ethers.keccak256(coder.encode(['uint16', 'bytes32'], [leafIndex, secret]));
}

function hashPair(left: string, right: string): string {
  return ethers.keccak256(coder.encode(['bytes32', 'bytes32'], [left, right]));
}

export function verifyMerkleProof(
  merkleRoot: string,
  leafIndex: number,
  secret: string,
  proof: string[],
): boolean {
  let hash = computeLeaf(leafIndex, secret);
  let idx = leafIndex;

  for (const sibling of proof) {
    hash = idx % 2 === 0
      ? hashPair(hash, sibling)   // current is left child
      : hashPair(sibling, hash);  // current is right child
    idx = Math.floor(idx / 2);
  }

  return hash.toLowerCase() === merkleRoot.toLowerCase();
}
