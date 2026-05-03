import { Router, Request, Response } from 'express';
import { verifyMerkleProof } from '../merkle.js';
import { getChannel, getX402State, advanceX402LeafIndex } from '../db.js';
import { notifyMerchantX402 } from '../notify.js';

export const x402Router = Router();

// GET /api/data  — x402-protected demo endpoint
//
// Client sends:  X-PAYMENT: base64(JSON({ payer, merchant, token, leafIndex, secret, proof[] }))
//
// We verify the proof off-chain (<1ms), advance the leaf counter, then:
//   1. Return 200 to the payer with the protected resource
//   2. POST to merchant's registered webhook with full proof data so they can
//      independently verify — we are a trusted intermediary but cannot cheat
//      because the math is public and anchored to the on-chain merkleRoot
x402Router.get('/data', async (req: Request, res: Response) => {
  const paymentHeader = req.headers['x-payment'] as string | undefined;

  if (!paymentHeader) {
    res.status(402).json({
      error: 'Payment Required',
      scheme: 'rootpay',
      details: {
        description: 'Include X-PAYMENT header with a RootPay Merkle proof',
        format: 'base64(JSON({ payer, merchant, token, leafIndex, secret, proof[] }))',
        contractAddress: process.env.ROOTPAY_CONTRACT_ADDRESS,
        network: 'base-sepolia',
      },
    });
    return;
  }

  let payment: { payer: string; merchant: string; token: string; leafIndex: number; secret: string; proof: string[] };
  try {
    payment = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
  } catch {
    res.status(400).json({ error: 'Invalid X-PAYMENT encoding' });
    return;
  }

  const { payer, merchant, token, leafIndex, secret, proof } = payment;
  if (!payer || !merchant || !token || leafIndex === undefined || !secret || !proof) {
    res.status(400).json({ error: 'Missing payment fields' });
    return;
  }

  const p = payer.toLowerCase();
  const m = merchant.toLowerCase();
  const t = token.toLowerCase();

  const channel = getChannel(p, m, t);
  if (!channel) {
    res.status(402).json({ error: 'No active channel found for this payer/merchant/token' });
    return;
  }
  if (!channel.merkle_root) {
    res.status(402).json({ error: 'Channel merkleRoot not yet synced — retry in a moment' });
    return;
  }
  if (channel.status !== 'open') {
    res.status(402).json({ error: `Channel is ${channel.status}` });
    return;
  }

  // Replay prevention: leafIndex must be strictly greater than last seen
  const { highestLeafIndex } = getX402State(p, m, t);
  if (leafIndex <= highestLeafIndex) {
    res.status(402).json({ error: `Leaf ${leafIndex} already used (highest seen: ${highestLeafIndex})` });
    return;
  }

  // Verify Merkle proof off-chain — mirrors RootPay.sol verifyMerkleProof exactly
  const valid = verifyMerkleProof(channel.merkle_root, leafIndex, secret, proof);
  if (!valid) {
    res.status(402).json({ error: 'Invalid Merkle proof' });
    return;
  }

  // Advance leaf counter
  advanceX402LeafIndex(p, m, t, leafIndex);

  const leafValue = (BigInt(channel.amount) * BigInt(leafIndex + 1)) / BigInt(channel.tree_size);

  // Notify merchant with full proof data — fire-and-forget
  notifyMerchantX402({
    merchantAddress: m,
    payer: p,
    merchant: m,
    token: t,
    leafIndex,
    secret,
    proof,
    merkleRoot: channel.merkle_root,
    leafValue: leafValue.toString(),
    totalDeposit: channel.amount,
    treeSize: channel.tree_size,
    contractAddress: process.env.ROOTPAY_CONTRACT_ADDRESS ?? '',
  }).catch((err) => console.error('[x402] notify error:', err));

  res.json({
    ok: true,
    data: { message: 'Protected resource delivered via RootPay micropayment' },
    payment: {
      leafIndex,
      leafValue: leafValue.toString(),
      totalDeposit: channel.amount,
      treeSize: channel.tree_size,
    },
  });
});
