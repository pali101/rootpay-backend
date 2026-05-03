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

// KeeperHub may send decoded args directly, or raw EVM log topics+data.
// We handle both.
export function decodeKeeperHubPayload(body: Record<string, unknown>): ParsedEvent {
  const txHash = (body.transactionHash as string) ?? (body.tx_hash as string) ?? '';
  const blockNumber = Number(body.blockNumber ?? body.block_number ?? 0);

  // ── Pre-decoded path (KeeperHub decoded for us) ───────────────────────────
  const eventName = (body.event ?? body.eventName ?? body.name) as string | undefined;
  const args = (body.args ?? body.data ?? body.params) as Record<string, unknown> | undefined;

  if (eventName && args) {
    return buildFromDecoded(eventName, args, txHash, blockNumber);
  }

  // ── Raw log path (topics + data hex) ─────────────────────────────────────
  const topics = body.topics as string[] | undefined;
  const data = (body.data ?? body.log_data) as string | undefined;

  if (topics && data !== undefined) {
    const parsed = iface.parseLog({ topics, data });
    if (!parsed) throw new Error('Unknown event topic');
    return buildFromDecoded(parsed.name, Object.fromEntries(
      parsed.fragment.inputs.map((inp, i) => [inp.name, parsed.args[i]])
    ), txHash, blockNumber);
  }

  throw new Error(`Cannot decode payload: ${JSON.stringify(body)}`);
}

function buildFromDecoded(
  name: string,
  args: Record<string, unknown>,
  txHash: string,
  blockNumber: number,
): ParsedEvent {
  const base = {
    payer: addr(String(args.payer)),
    merchant: addr(String(args.merchant)),
    token: addr(String(args.token)),
    txHash,
    blockNumber,
  };

  switch (name) {
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
