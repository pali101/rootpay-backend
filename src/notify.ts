import { getMerchantWebhook } from './db.js';
import type { ParsedEvent } from './decoder.js';

async function fire(merchantAddress: string, payload: Record<string, unknown>): Promise<void> {
  const url = getMerchantWebhook(merchantAddress);
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[notify] merchant webhook ${res.status} for ${merchantAddress}`);
    }
  } catch (err) {
    console.error(`[notify] failed to reach ${url}:`, err);
  }
}

// ── Channel lifecycle events (from KeeperHub) ─────────────────────────────────

export async function notifyMerchant(event: ParsedEvent): Promise<void> {
  const payload = buildChannelPayload(event);
  if (!payload) return;
  await fire(event.merchant, payload);
}

function buildChannelPayload(event: ParsedEvent): Record<string, unknown> | null {
  switch (event.type) {
    case 'ChannelCreated':
      return {
        event: 'channel_opened',
        payer: event.payer,
        merchant: event.merchant,
        token: event.token,
        amount: event.amount,
        treeSize: event.treeSize,
        merchantWithdrawAfterBlock: event.merchantWithdrawAfterBlock,
        txHash: event.txHash,
      };

    case 'ChannelRedeemed':
      return {
        event: 'channel_redeemed',
        payer: event.payer,
        merchant: event.merchant,
        token: event.token,
        amountPaid: event.amountPaid,
        leafIndex: event.leafIndex,
        txHash: event.txHash,
      };

    case 'ChannelReclaimed':
      return {
        event: 'channel_reclaimed',
        payer: event.payer,
        merchant: event.merchant,
        token: event.token,
        txHash: event.txHash,
      };

    // ChannelRefunded fires alongside ChannelRedeemed — no separate notification
    default:
      return null;
  }
}

// ── x402 payment notifications ────────────────────────────────────────────────
//
// We act as a trusted intermediary but provide all data needed to verify
// independently. Even if our `ourAssessment` is wrong, the merchant can
// recompute the Merkle proof using the raw fields below.
//
// Verification formula (mirrors RootPay.sol exactly):
//   leaf   = keccak256(abi.encode(leafIndex, secret))
//   parent = keccak256(abi.encode(left, right))          <-- NOT encodePacked
//   valid  = computed root == merkleRoot

export interface X402PaymentNotification {
  merchantAddress: string;
  payer: string;
  merchant: string;
  token: string;
  leafIndex: number;
  secret: string;
  proof: string[];
  merkleRoot: string;
  leafValue: string;
  totalDeposit: string;
  treeSize: number;
  contractAddress: string;
}

export async function notifyMerchantX402(n: X402PaymentNotification): Promise<void> {
  await fire(n.merchantAddress, {
    event: 'payment_received',

    // Our assessment — you do not have to trust this
    ourAssessment: 'valid',

    // Channel identifiers
    payer: n.payer,
    merchant: n.merchant,
    token: n.token,

    // Economics
    leafIndex: n.leafIndex,
    leafValue: n.leafValue,
    totalDeposit: n.totalDeposit,
    treeSize: n.treeSize,

    // Full proof — verify this yourself, we are not the source of truth
    proof: {
      secret: n.secret,
      siblings: n.proof,
      merkleRoot: n.merkleRoot,
    },

    // On-chain verification anchor
    contract: {
      address: n.contractAddress,
      network: 'base-sepolia',
      function: 'verifyMerkleProof(bytes32 merkleRoot, uint16 leafIndex, bytes32 secret, bytes32[] proof) → bool',
    },

    // Self-verification recipe
    selfVerify: {
      step1: 'leaf = keccak256(abi.encode(leafIndex, secret))',
      step2: 'walk proof: if index%2==0 → keccak256(abi.encode(current,sibling)), else keccak256(abi.encode(sibling,current))',
      step3: 'result must equal merkleRoot',
      note: 'Uses abi.encode (padded), not encodePacked',
    },
  });
}
