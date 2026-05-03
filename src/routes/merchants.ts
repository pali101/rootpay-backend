import { Router, Request, Response } from 'express';
import { upsertMerchantWebhook, getMerchantWebhook } from '../db.js';

export const merchantsRouter = Router();

// POST /merchants/webhook  — register or update callback URL
merchantsRouter.post('/webhook', (req: Request, res: Response) => {
  const { merchantAddress, webhookUrl } = req.body as { merchantAddress?: string; webhookUrl?: string };

  if (!merchantAddress || !webhookUrl) {
    res.status(400).json({ error: 'merchantAddress and webhookUrl are required' });
    return;
  }

  try {
    new URL(webhookUrl);
  } catch {
    res.status(400).json({ error: 'Invalid webhookUrl' });
    return;
  }

  upsertMerchantWebhook(merchantAddress.toLowerCase(), webhookUrl);
  res.json({ ok: true, merchantAddress: merchantAddress.toLowerCase(), webhookUrl });
});

// GET /merchants/:address/webhook  — check registered URL
merchantsRouter.get('/:address/webhook', (req: Request, res: Response) => {
  const url = getMerchantWebhook(req.params.address.toLowerCase());
  if (!url) {
    res.status(404).json({ error: 'No webhook registered for this merchant' });
    return;
  }
  res.json({ merchantAddress: req.params.address.toLowerCase(), webhookUrl: url });
});
