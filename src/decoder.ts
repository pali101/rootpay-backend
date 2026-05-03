import { ethers } from 'ethers';

// Minimal ABI — only events needed for decoding raw logs
const ABI = [
  'event ChannelCreated(address indexed payer, address indexed merchant, address token, uint256 amount, uint16 treeSize, uint64 merchantWithdrawAfterBlocks)',
  'event ChannelRedeemed(address indexed payer, address indexed merchant, address token, uint256 amountPaid, uint16 leafIndex)',
  'event ChannelRefunded(address indexed payer, address indexed merchant, address token, uint256 refundAmount)',
  'event ChannelReclaimed(address indexed payer, address indexed merchant, address token, uint64 blockNumber)',
];

const iface = new ethers.Interface(ABI);

export type EventType = 'ChannelCreated' | 'ChannelRedeemed' | 'ChannelRefunded' | 'ChannelReclaimed';

export interface ParsedEvent {
  type: EventType;
  payer: string;
  merchant: string;
  token: string;
  txHash: string;
  blockNumber: number;
  // ChannelCreated
  amount?: string;
  treeSize?: number;
  merchantWithdrawAfterBlock?: number;
  // ChannelRedeemed
  amountPaid?: string;
  leafIndex?: number;
  // ChannelRefunded
  refundAmount?: string;
  // ChannelReclaimed
  reclaimedAtBlock?: number;
}

function addr(v: string) {
  return v.toLowerCase();
}

// KeeperHub concatenated payload format:
// payer(0x+40hex) + merchant(0x+40hex) + amount+treeSize(decimal) + txHash(0x+64hex) + merchantWithdrawAfterBlocks+blockNumber(decimal)
// All fields joined with no separator.
const CONCAT_RE = /^(0x[0-9a-fA-F]{40})(0x[0-9a-fA-F]{40})(\d+)(0x[0-9a-fA-F]{64})(\d+)$/i;

function splitAmountTreeSize(combined: string): { amount: string; treeSize: number } {
  // treeSize is uint16, typically a power of 2 (1024, 2048, 4096, 8192 = 4 digits).
  // Try 4 digits first, then 5, then 3, 2, 1 — avoids matching a single trailing digit.
  for (const len of [4, 5, 3, 2, 1]) {
    if (combined.length <= len) continue;
    const ts = parseInt(combined.slice(-len), 10);
    if (ts > 0 && (ts & (ts - 1)) === 0) {
      return { amount: combined.slice(0, -len), treeSize: ts };
    }
  }
  // Fallback: last 4 chars as treeSize
  return { amount: combined.slice(0, -4), treeSize: parseInt(combined.slice(-4), 10) };
}

function parseKeeperHubConcatPayload(raw: string): ParsedEvent {
  const m = raw.trim().match(CONCAT_RE);
  if (!m) throw new Error(`Cannot parse KeeperHub concat payload: ${raw.slice(0, 120)}`);

  const [, payer, merchant, amountAndTreeSize, txHash, blocksRemainder] = m;

  const { amount, treeSize } = splitAmountTreeSize(amountAndTreeSize);

  // blocksRemainder = merchantWithdrawAfterBlocks + blockNumber (both ~same magnitude on Base Sepolia)
  const mid = Math.floor(blocksRemainder.length / 2);
  const merchantWithdrawAfterBlock = Number(blocksRemainder.slice(0, mid));
  const blockNumber = Number(blocksRemainder.slice(mid));

  const token = (process.env.TOKEN_ADDRESS ?? '0x0000000000000000000000000000000000000000').toLowerCase();

  return {
    type: 'ChannelCreated',
    payer: addr(payer),
    merchant: addr(merchant),
    token,
    txHash,
    blockNumber,
    amount,
    treeSize,
    merchantWithdrawAfterBlock,
  };
}

// KeeperHub may send:
//   1. Decoded JSON  { event, args, transactionHash, blockNumber }
//   2. Raw EVM log   { topics, data, transactionHash }
//   3. Wrapper JSON  { webhookPayload: "<concat string>" }  (KeeperHub no-code format)
//   4. Plain string  "<concat string>"  (sent as text/plain)
export function decodeKeeperHubPayload(body: Record<string, unknown> | string): ParsedEvent {
  // Normalise to an object
  let resolved: Record<string, unknown>;
  if (typeof body === 'string') {
    try {
      resolved = JSON.parse(body);
    } catch {
      // Treat the whole string as the concatenated payload
      return parseKeeperHubConcatPayload(body);
    }
  } else {
    resolved = body;
  }

  const txHash = (resolved.transactionHash as string) ?? (resolved.tx_hash as string) ?? '';
  const blockNumber = Number(resolved.blockNumber ?? resolved.block_number ?? 0);

  // ── KeeperHub no-code wrapper { webhookPayload: "0x..." } ───────────────────
  if (typeof resolved.webhookPayload === 'string') {
    return parseKeeperHubConcatPayload(resolved.webhookPayload);
  }

  // ── Pre-decoded path (KeeperHub decoded for us) ───────────────────────────
  const eventName = (resolved.event ?? resolved.eventName ?? resolved.name) as string | undefined;
  const args = (resolved.args ?? resolved.data ?? resolved.params) as Record<string, unknown> | undefined;

  if (eventName && args) {
    return buildFromDecoded(eventName, args, txHash, blockNumber);
  }

  // ── Raw log path (topics + data hex) ─────────────────────────────────────
  const topics = resolved.topics as string[] | undefined;
  const data = (resolved.data ?? resolved.log_data) as string | undefined;

  if (topics && data !== undefined) {
    const parsed = iface.parseLog({ topics, data });
    if (!parsed) throw new Error('Unknown event topic');
    return buildFromDecoded(parsed.name, Object.fromEntries(
      parsed.fragment.inputs.map((inp, i) => [inp.name, parsed.args[i]])
    ), txHash, blockNumber);
  }

  throw new Error(`Cannot decode payload: ${JSON.stringify(resolved)}`);
}

// Normalise KeeperHub event names: "Channel Created" → "ChannelCreated"
function normaliseEventName(name: string): string {
  return name.replace(/\s+/g, '');
}

function buildFromDecoded(
  name: string,
  args: Record<string, unknown>,
  txHash: string,
  blockNumber: number,
): ParsedEvent {
  const fallbackToken = (process.env.TOKEN_ADDRESS ?? '0x0000000000000000000000000000000000000000').toLowerCase();
  const base = {
    payer: addr(String(args.payer)),
    merchant: addr(String(args.merchant)),
    token: args.token ? addr(String(args.token)) : fallbackToken,
    txHash,
    blockNumber,
  };

  switch (normaliseEventName(name)) {
    case 'ChannelCreated':
      return {
        type: 'ChannelCreated',
        ...base,
        amount: BigInt(String(args.amount)).toString(),
        treeSize: Number(args.treeSize),
        merchantWithdrawAfterBlock: Number(args.merchantWithdrawAfterBlocks ?? args.merchantWithdrawAfterBlock),
      };

    case 'ChannelRedeemed':
      return {
        type: 'ChannelRedeemed',
        ...base,
        amountPaid: BigInt(String(args.amountPaid)).toString(),
        leafIndex: Number(args.leafIndex),
      };

    case 'ChannelRefunded':
      return {
        type: 'ChannelRefunded',
        ...base,
        refundAmount: BigInt(String(args.refundAmount)).toString(),
      };

    case 'ChannelReclaimed':
      return {
        type: 'ChannelReclaimed',
        ...base,
        reclaimedAtBlock: Number(args.blockNumber),
      };

    default:
      throw new Error(`Unhandled event: ${name}`);
  }
}
