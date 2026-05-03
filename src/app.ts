import express from 'express';
import { webhookRouter } from './routes/webhook.js';
import { channelsRouter } from './routes/channels.js';
import { merchantsRouter } from './routes/merchants.js';
import { x402Router } from './routes/x402.js';

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      contract: process.env.ROOTPAY_CONTRACT_ADDRESS ?? 'not set',
      network: 'base-sepolia',
    });
  });

  app.use('/webhook', webhookRouter);
  app.use('/channels', channelsRouter);
  app.use('/merchants', merchantsRouter);
  app.use('/api', x402Router);

  return app;
}
