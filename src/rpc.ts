import { ethers } from 'ethers';

const ABI = [
  'function channelsMapping(address payer, address merchant, address token) view returns (address token, bytes32 merkleRoot, uint256 amount, uint16 treeSize, uint64 merchantWithdrawAfterBlocks, uint64 payerWithdrawAfterBlocks)',
];

let provider: ethers.JsonRpcProvider | null = null;
let contract: ethers.Contract | null = null;

function getContract(): ethers.Contract {
  if (contract) return contract;
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
  const contractAddress = process.env.ROOTPAY_CONTRACT_ADDRESS;
  if (!contractAddress) throw new Error('ROOTPAY_CONTRACT_ADDRESS not set');
  provider = new ethers.JsonRpcProvider(rpcUrl);
  contract = new ethers.Contract(contractAddress, ABI, provider);
  return contract;
}

export interface OnChainChannel {
  merkleRoot: string;
  amount: string;
  treeSize: number;
  merchantWithdrawAfterBlocks: number;
  payerWithdrawAfterBlocks: number;
}

export async function fetchChannelFromChain(
  payer: string,
  merchant: string,
  token: string,
): Promise<OnChainChannel | null> {
  try {
    const c = getContract();
    const result = await c.channelsMapping(payer, merchant, token);
    // Channel doesn't exist when amount === 0
    if (result.amount === 0n) return null;
    return {
      merkleRoot: result.merkleRoot as string,
      amount: result.amount.toString(),
      treeSize: Number(result.treeSize),
      merchantWithdrawAfterBlocks: Number(result.merchantWithdrawAfterBlocks),
      payerWithdrawAfterBlocks: Number(result.payerWithdrawAfterBlocks),
    };
  } catch (err) {
    console.error('[rpc] fetchChannelFromChain failed:', err);
    return null;
  }
}
