import { Router, Request, Response } from 'express';
import { getChannelsByMerchant, getChannel, getEventsByMerchant } from '../db.js';

export const channelsRouter = Router();

// GET /channels/:merchant  — all channels for a merchant
channelsRouter.get('/:merchant', (req: Request, res: Response) => {
  const merchant = req.params.merchant.toLowerCase();
  const channels = getChannelsByMerchant(merchant);
  res.json({ merchant, channels });
});

// GET /channels/:payer/:merchant/:token  — specific channel
channelsRouter.get('/:payer/:merchant/:token', (req: Request, res: Response) => {
  const { payer, merchant, token } = req.params;
  const channel = getChannel(payer.toLowerCase(), merchant.toLowerCase(), token.toLowerCase());
  if (!channel) {
    res.status(404).json({ error: 'Channel not found' });
    return;
  }
  res.json(channel);
});

// GET /events?merchant=0x...&limit=20
channelsRouter.get('/', (req: Request, res: Response) => {
  const merchant = (req.query.merchant as string | undefined)?.toLowerCase();
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  if (!merchant) {
    res.status(400).json({ error: 'merchant query param required' });
    return;
  }
  const events = getEventsByMerchant(merchant, limit);
  res.json({ merchant, events });
});
