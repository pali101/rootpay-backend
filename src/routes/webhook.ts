import { Router, Request, Response } from 'express';
import { decodeKeeperHubPayload } from '../decoder.js';
import { upsertChannel, closeChannel, insertEvent, patchChannelMerkleRoot } from '../db.js';
import { fetchChannelFromChain } from '../rpc.js';
import { notifyMerchant } from '../notify.js';

export const webhookRouter = Router();

webhookRouter.post('/keeperhub', async (req: Request, res: Response) => {
  // Always 200 immediately — KeeperHub won't retry on 2xx
  res.sendStatus(200);

  const body = req.body as Record<string, unknown> | string;
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  console.log('[webhook] received body type:', typeof body, '| preview:', raw.slice(0, 120));

  let event;
  try {
    event = decodeKeeperHubPayload(body);
  } catch (err) {
    console.error('[webhook] decode error:', err, '\nbody:', raw);
    return;
  }

  console.log(`[webhook] ${event.type} payer=${event.payer} merchant=${event.merchant}`);

  // Persist event log
  insertEvent({
    eventType: event.type,
    payer: event.payer,
    merchant: event.merchant,
    token: event.token,
    txHash: event.txHash,
    blockNumber: event.blockNumber,
    amount: event.amount ?? event.amountPaid ?? event.refundAmount,
    leafIndex: event.leafIndex,
    rawPayload: raw,
  });

  switch (event.type) {
    case 'ChannelCreated': {
      upsertChannel({
        payer: event.payer,
        merchant: event.merchant,
        token: event.token,
        amount: event.amount!,
        treeSize: event.treeSize!,
        merchantWithdrawAfterBlock: event.merchantWithdrawAfterBlock,
        status: 'open',
        openTx: event.txHash,
      });

      // merkleRoot is not in the event — fetch from chain
      fetchChannelFromChain(event.payer, event.merchant, event.token).then((chain) => {
        if (chain?.merkleRoot) {
          patchChannelMerkleRoot(event.payer, event.merchant, event.token, chain.merkleRoot);
          console.log(`[webhook] stored merkleRoot for ${event.payer}→${event.merchant}`);
        }
      });

      break;
    }

    case 'ChannelRedeemed': {
      closeChannel(event.payer, event.merchant, event.token, 'redeemed', event.txHash);
      break;
    }

    case 'ChannelReclaimed': {
      closeChannel(event.payer, event.merchant, event.token, 'reclaimed', event.txHash);
      break;
    }

    case 'ChannelRefunded':
      // No channel-state change needed (fires alongside ChannelRedeemed)
      break;
  }

  // Notify merchant async (fire-and-forget)
  notifyMerchant(event).catch((err) => console.error('[webhook] notify error:', err));
});
