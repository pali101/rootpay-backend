import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { ethers } from 'ethers';

// Reset DB to in-memory BEFORE any module that touches getDb() is imported
import { _resetDbForTesting, upsertChannel, patchChannelMerkleRoot } from '../src/db.js';
_resetDbForTesting(':memory:');

import { createApp } from '../src/app.js';

const PAYER    = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const MERCHANT = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const TOKEN    = '0x0000000000000000000000000000000000000000';

// ── test Merkle tree (treeSize=2) so x402 tests can produce valid proofs ──────
const coder = ethers.AbiCoder.defaultAbiCoder();
const SECRET0 = '0x' + '00'.repeat(31) + '01';
const SECRET1 = '0x' + '00'.repeat(31) + '02';
const L0 = ethers.keccak256(coder.encode(['uint16', 'bytes32'], [0, SECRET0]));
const L1 = ethers.keccak256(coder.encode(['uint16', 'bytes32'], [1, SECRET1]));
const MERKLE_ROOT = ethers.keccak256(coder.encode(['bytes32', 'bytes32'], [L0, L1]));

function makePaymentHeader(leafIndex: number, secret: string, proof: string[]) {
  return Buffer.from(JSON.stringify({ payer: PAYER, merchant: MERCHANT, token: TOKEN, leafIndex, secret, proof })).toString('base64');
}

async function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(base: string, path: string, headers?: Record<string, string>) {
  return fetch(`${base}${path}`, { headers });
}

let server: Server;
let base: string;

before(() => {
  process.env.ROOTPAY_CONTRACT_ADDRESS = '0x1234567890123456789012345678901234567890';
  server = createApp().listen(0);
  const port = (server.address() as AddressInfo).port;
  base = `http://localhost:${port}`;
});

after(() => new Promise<void>((res) => server.close(() => res())));

// ── /health ───────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  test('returns 200 with status ok', async () => {
    const res = await get(base, '/health');
    assert.equal(res.status, 200);
    const body = await res.json() as { status: string };
    assert.equal(body.status, 'ok');
  });
});

// ── /merchants/webhook ────────────────────────────────────────────────────────

describe('POST /merchants/webhook', () => {
  test('registers a webhook URL', async () => {
    const res = await post(base, '/merchants/webhook', {
      merchantAddress: MERCHANT,
      webhookUrl: 'https://example.com/hook',
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);
  });

  test('400 when merchantAddress missing', async () => {
    const res = await post(base, '/merchants/webhook', { webhookUrl: 'https://example.com' });
    assert.equal(res.status, 400);
  });

  test('400 when webhookUrl is not a valid URL', async () => {
    const res = await post(base, '/merchants/webhook', {
      merchantAddress: MERCHANT,
      webhookUrl: 'not-a-url',
    });
    assert.equal(res.status, 400);
  });
});

describe('GET /merchants/:address/webhook', () => {
  test('returns registered URL', async () => {
    const res = await get(base, `/merchants/${MERCHANT}/webhook`);
    assert.equal(res.status, 200);
    const body = await res.json() as { webhookUrl: string };
    assert.equal(body.webhookUrl, 'https://example.com/hook');
  });

  test('404 for unknown merchant', async () => {
    const res = await get(base, `/merchants/0x${'aa'.repeat(20)}/webhook`);
    assert.equal(res.status, 404);
  });
});

// ── /webhook/keeperhub ────────────────────────────────────────────────────────

describe('POST /webhook/keeperhub', () => {
  test('ChannelCreated: stores channel with status open', async () => {
    const res = await post(base, '/webhook/keeperhub', {
      event: 'ChannelCreated',
      transactionHash: '0xopen1',
      blockNumber: 1000,
      args: {
        payer: PAYER,
        merchant: MERCHANT,
        token: TOKEN,
        amount: '100000000000000000',
        treeSize: 1024,
        merchantWithdrawAfterBlocks: 1100,
      },
    });
    assert.equal(res.status, 200);

    // Give the async RPC fetch a moment (it will fail silently — no real RPC in tests)
    await new Promise((r) => setTimeout(r, 50));

    const channelRes = await get(base, `/channels/${MERCHANT}`);
    const body = await channelRes.json() as { channels: Array<{ status: string; open_tx: string }> };
    assert.equal(body.channels.length, 1);
    assert.equal(body.channels[0].status, 'open');
    assert.equal(body.channels[0].open_tx, '0xopen1');
  });

  test('ChannelRedeemed: updates status to redeemed', async () => {
    const res = await post(base, '/webhook/keeperhub', {
      event: 'ChannelRedeemed',
      transactionHash: '0xredeem1',
      blockNumber: 1101,
      args: {
        payer: PAYER,
        merchant: MERCHANT,
        token: TOKEN,
        amountPaid: '70000000000000000',
        leafIndex: 716,
      },
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 50));

    const channelRes = await get(base, `/channels/${MERCHANT}`);
    const body = await channelRes.json() as { channels: Array<{ status: string; close_tx: string }> };
    assert.equal(body.channels[0].status, 'redeemed');
    assert.equal(body.channels[0].close_tx, '0xredeem1');
  });

  test('ChannelRefunded: acknowledged, no crash', async () => {
    const res = await post(base, '/webhook/keeperhub', {
      event: 'ChannelRefunded',
      transactionHash: '0xrefund1',
      blockNumber: 1101,
      args: {
        payer: PAYER,
        merchant: MERCHANT,
        token: TOKEN,
        refundAmount: '30000000000000000',
      },
    });
    assert.equal(res.status, 200);
  });

  test('ChannelReclaimed: updates status to reclaimed', async () => {
    // First re-open the channel (upsert) so there is something to reclaim
    upsertChannel({
      payer: PAYER,
      merchant: MERCHANT,
      token: TOKEN,
      amount: '100000000000000000',
      treeSize: 1024,
      status: 'open',
      openTx: '0xopen2',
    });

    const res = await post(base, '/webhook/keeperhub', {
      event: 'ChannelReclaimed',
      transactionHash: '0xreclaim1',
      blockNumber: 2000,
      args: {
        payer: PAYER,
        merchant: MERCHANT,
        token: TOKEN,
        blockNumber: 2000,
      },
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 50));

    const channelRes = await get(base, `/channels/${MERCHANT}`);
    const body = await channelRes.json() as { channels: Array<{ status: string }> };
    assert.equal(body.channels[0].status, 'reclaimed');
  });

  test('malformed payload: 200 (never fail KeeperHub delivery)', async () => {
    const res = await post(base, '/webhook/keeperhub', { garbage: true });
    assert.equal(res.status, 200);
  });
});

// ── /channels ─────────────────────────────────────────────────────────────────

describe('GET /channels/:payer/:merchant/:token', () => {
  test('returns specific channel', async () => {
    const res = await get(base, `/channels/${PAYER}/${MERCHANT}/${TOKEN}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { payer: string; merchant: string };
    assert.equal(body.payer, PAYER.toLowerCase());
    assert.equal(body.merchant, MERCHANT.toLowerCase());
  });

  test('404 for unknown channel', async () => {
    const res = await get(base, `/channels/${'0x' + 'aa'.repeat(20)}/${MERCHANT}/${TOKEN}`);
    assert.equal(res.status, 404);
  });
});

describe('GET /events', () => {
  test('returns events for merchant', async () => {
    const res = await get(base, `/channels?merchant=${MERCHANT}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { events: unknown[] };
    assert.ok(Array.isArray(body.events));
    assert.ok(body.events.length > 0);
  });

  test('400 when merchant param missing', async () => {
    const res = await get(base, `/channels`);
    assert.equal(res.status, 400);
  });
});

// ── /api/data (x402) ─────────────────────────────────────────────────────────

describe('GET /api/data (x402)', () => {
  before(() => {
    // Set up a fresh open channel with a known merkleRoot for x402 tests
    upsertChannel({
      payer: PAYER,
      merchant: MERCHANT,
      token: TOKEN,
      amount: '200',   // treeSize=2, amount=200 → each leaf worth 100
      treeSize: 2,
      status: 'open',
      openTx: '0xx402open',
    });
    patchChannelMerkleRoot(PAYER, MERCHANT, TOKEN, MERKLE_ROOT);
  });

  test('returns 402 with payment instructions when no header', async () => {
    const res = await get(base, '/api/data');
    assert.equal(res.status, 402);
    const body = await res.json() as { scheme: string };
    assert.equal(body.scheme, 'rootpay');
  });

  test('accepts valid leaf-0 proof → 200', async () => {
    // Proof for leaf 0 in a 2-leaf tree: sibling is L1
    const header = makePaymentHeader(0, SECRET0, [L1]);
    const res = await get(base, '/api/data', { 'X-PAYMENT': header });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; payment: { leafIndex: number } };
    assert.equal(body.ok, true);
    assert.equal(body.payment.leafIndex, 0);
  });

  test('accepts valid leaf-1 proof → 200', async () => {
    const header = makePaymentHeader(1, SECRET1, [L0]);
    const res = await get(base, '/api/data', { 'X-PAYMENT': header });
    assert.equal(res.status, 200);
  });

  test('replaying leaf-0 (already used) → 402', async () => {
    const header = makePaymentHeader(0, SECRET0, [L1]);
    const res = await get(base, '/api/data', { 'X-PAYMENT': header });
    assert.equal(res.status, 402);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes('already used'));
  });

  test('invalid Merkle proof → 402', async () => {
    // Use a fresh payer so replay prevention doesn't fire before proof check
    const freshPayer = '0xcccccccccccccccccccccccccccccccccccccccc';
    upsertChannel({ payer: freshPayer, merchant: MERCHANT, token: TOKEN, amount: '200', treeSize: 2, status: 'open', openTx: '0xx402fresh' });
    patchChannelMerkleRoot(freshPayer, MERCHANT, TOKEN, MERKLE_ROOT);

    const badHeader = Buffer.from(JSON.stringify({
      payer: freshPayer, merchant: MERCHANT, token: TOKEN,
      leafIndex: 0, secret: SECRET0, proof: [L0], // L0 instead of L1 — wrong sibling
    })).toString('base64');
    const res = await get(base, '/api/data', { 'X-PAYMENT': badHeader });
    assert.equal(res.status, 402);
    const body = await res.json() as { error: string };
    assert.ok(body.error.toLowerCase().includes('invalid'));
  });

  test('wrong secret → 402', async () => {
    const wrongSecret = '0x' + 'ff'.repeat(32);
    const header = makePaymentHeader(0, wrongSecret, [L1]);
    const res = await get(base, '/api/data', { 'X-PAYMENT': header });
    assert.equal(res.status, 402);
  });

  test('malformed base64 → 400', async () => {
    const res = await get(base, '/api/data', { 'X-PAYMENT': '!!!not_base64!!!' });
    assert.equal(res.status, 400);
  });
});
