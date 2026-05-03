import { DatabaseSync } from 'node:sqlite';
import path from 'path';

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!db) {
    const dbPath = process.env.ROOTPAY_DB_PATH ?? path.join(process.cwd(), 'rootpay.db');
    db = new DatabaseSync(dbPath);
    applySchema(db);
  }
  return db;
}

// For test isolation — call this before any route handlers run
export function _resetDbForTesting(dbPath = ':memory:'): void {
  db = new DatabaseSync(dbPath);
  applySchema(db);
}

function applySchema(d: DatabaseSync): void {
  d.exec(`PRAGMA journal_mode = WAL`);
  d.exec(`PRAGMA foreign_keys = ON`);
  d.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id                              INTEGER PRIMARY KEY AUTOINCREMENT,
      payer                           TEXT NOT NULL,
      merchant                        TEXT NOT NULL,
      token                           TEXT NOT NULL,
      amount                          TEXT NOT NULL,
      tree_size                       INTEGER NOT NULL,
      merkle_root                     TEXT,
      merchant_withdraw_after_block   INTEGER,
      status                          TEXT NOT NULL DEFAULT 'open',
      open_tx                         TEXT,
      close_tx                        TEXT,
      created_at                      INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(payer, merchant, token)
    );

    CREATE TABLE IF NOT EXISTS events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type    TEXT NOT NULL,
      payer         TEXT NOT NULL,
      merchant      TEXT NOT NULL,
      token         TEXT NOT NULL,
      tx_hash       TEXT,
      block_number  INTEGER,
      amount        TEXT,
      leaf_index    INTEGER,
      raw_payload   TEXT,
      created_at    INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS merchant_webhooks (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_address TEXT NOT NULL UNIQUE,
      webhook_url      TEXT NOT NULL,
      created_at       INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS x402_payments (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      payer               TEXT NOT NULL,
      merchant            TEXT NOT NULL,
      token               TEXT NOT NULL,
      highest_leaf_index  INTEGER NOT NULL DEFAULT -1,
      updated_at          INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(payer, merchant, token)
    );
  `);
}

// ── channels ──────────────────────────────────────────────────────────────────

export function upsertChannel(data: {
  payer: string;
  merchant: string;
  token: string;
  amount: string;
  treeSize: number;
  merkleRoot?: string;
  merchantWithdrawAfterBlock?: number;
  status?: string;
  openTx?: string;
  closeTx?: string;
}) {
  getDb().prepare(`
    INSERT INTO channels
      (payer, merchant, token, amount, tree_size, merkle_root, merchant_withdraw_after_block, status, open_tx, close_tx)
    VALUES
      (:payer, :merchant, :token, :amount, :treeSize, :merkleRoot, :merchantWithdrawAfterBlock, :status, :openTx, :closeTx)
    ON CONFLICT(payer, merchant, token) DO UPDATE SET
      merkle_root                   = COALESCE(excluded.merkle_root, merkle_root),
      merchant_withdraw_after_block = COALESCE(excluded.merchant_withdraw_after_block, merchant_withdraw_after_block),
      status                        = excluded.status,
      close_tx                      = COALESCE(excluded.close_tx, close_tx)
  `).run({
    payer: data.payer,
    merchant: data.merchant,
    token: data.token,
    amount: data.amount,
    treeSize: data.treeSize,
    merkleRoot: data.merkleRoot ?? null,
    merchantWithdrawAfterBlock: data.merchantWithdrawAfterBlock ?? null,
    status: data.status ?? 'open',
    openTx: data.openTx ?? null,
    closeTx: data.closeTx ?? null,
  });
}

export function patchChannelMerkleRoot(payer: string, merchant: string, token: string, merkleRoot: string) {
  getDb().prepare(
    `UPDATE channels SET merkle_root = :merkleRoot WHERE payer = :payer AND merchant = :merchant AND token = :token`
  ).run({ merkleRoot, payer, merchant, token });
}

export function closeChannel(
  payer: string,
  merchant: string,
  token: string,
  status: 'redeemed' | 'reclaimed',
  closeTx: string,
) {
  getDb().prepare(
    `UPDATE channels SET status = :status, close_tx = :closeTx WHERE payer = :payer AND merchant = :merchant AND token = :token`
  ).run({ status, closeTx, payer, merchant, token });
}

export function getChannelsByMerchant(merchant: string): ChannelRow[] {
  return getDb().prepare(
    `SELECT * FROM channels WHERE merchant = :merchant ORDER BY created_at DESC`
  ).all({ merchant }) as unknown as ChannelRow[];
}

export function getChannel(payer: string, merchant: string, token: string): ChannelRow | undefined {
  return getDb().prepare(
    `SELECT * FROM channels WHERE payer = :payer AND merchant = :merchant AND token = :token`
  ).get({ payer, merchant, token }) as ChannelRow | undefined;
}

// ── events ────────────────────────────────────────────────────────────────────

export function insertEvent(data: {
  eventType: string;
  payer: string;
  merchant: string;
  token: string;
  txHash?: string;
  blockNumber?: number;
  amount?: string;
  leafIndex?: number;
  rawPayload: string;
}) {
  getDb().prepare(`
    INSERT INTO events (event_type, payer, merchant, token, tx_hash, block_number, amount, leaf_index, raw_payload)
    VALUES (:eventType, :payer, :merchant, :token, :txHash, :blockNumber, :amount, :leafIndex, :rawPayload)
  `).run({
    eventType: data.eventType,
    payer: data.payer,
    merchant: data.merchant,
    token: data.token,
    txHash: data.txHash ?? null,
    blockNumber: data.blockNumber ?? null,
    amount: data.amount ?? null,
    leafIndex: data.leafIndex ?? null,
    rawPayload: data.rawPayload,
  });
}

export function getEventsByMerchant(merchant: string, limit = 50): unknown[] {
  return getDb().prepare(
    `SELECT * FROM events WHERE merchant = :merchant ORDER BY created_at DESC LIMIT :limit`
  ).all({ merchant, limit });
}

// ── merchant webhooks ─────────────────────────────────────────────────────────

export function upsertMerchantWebhook(merchantAddress: string, webhookUrl: string) {
  getDb().prepare(`
    INSERT INTO merchant_webhooks (merchant_address, webhook_url)
    VALUES (:merchantAddress, :webhookUrl)
    ON CONFLICT(merchant_address) DO UPDATE SET webhook_url = excluded.webhook_url
  `).run({ merchantAddress, webhookUrl });
}

export function getMerchantWebhook(merchantAddress: string): string | undefined {
  const row = getDb().prepare(
    `SELECT webhook_url FROM merchant_webhooks WHERE merchant_address = :merchantAddress`
  ).get({ merchantAddress }) as { webhook_url: string } | undefined;
  return row?.webhook_url;
}

// ── x402 payments ─────────────────────────────────────────────────────────────

export function getX402State(payer: string, merchant: string, token: string): { highestLeafIndex: number } {
  const row = getDb().prepare(
    `SELECT highest_leaf_index FROM x402_payments WHERE payer = :payer AND merchant = :merchant AND token = :token`
  ).get({ payer, merchant, token }) as { highest_leaf_index: number } | undefined;
  return { highestLeafIndex: row?.highest_leaf_index ?? -1 };
}

export function advanceX402LeafIndex(payer: string, merchant: string, token: string, leafIndex: number) {
  getDb().prepare(`
    INSERT INTO x402_payments (payer, merchant, token, highest_leaf_index, updated_at)
    VALUES (:payer, :merchant, :token, :leafIndex, strftime('%s','now'))
    ON CONFLICT(payer, merchant, token) DO UPDATE SET
      highest_leaf_index = :leafIndex,
      updated_at = strftime('%s','now')
  `).run({ payer, merchant, token, leafIndex });
}

// ── types ─────────────────────────────────────────────────────────────────────

export interface ChannelRow {
  id: number;
  payer: string;
  merchant: string;
  token: string;
  amount: string;
  tree_size: number;
  merkle_root: string | null;
  merchant_withdraw_after_block: number | null;
  status: string;
  open_tx: string | null;
  close_tx: string | null;
  created_at: number;
}
