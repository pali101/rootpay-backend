# RootPay Backend

KeeperHub integration layer for the [RootPay](https://github.com/pali101/RootPay) Merkle-indexed micropayment protocol on Base Sepolia.

## What it does

1. **Receives KeeperHub webhooks** when RootPay contract events fire on-chain
2. **Persists channel state** (open → redeemed/reclaimed) in SQLite
3. **Notifies merchants** at their registered webhook URL for every lifecycle event
4. **Verifies x402 micropayments** off-chain — full proof forwarded to merchant so they can independently verify

## Architecture

```
RootPay Contract (Base Sepolia)
        │  ChannelCreated / ChannelRedeemed / ChannelRefunded / ChannelReclaimed
        ▼
  KeeperHub Workflow  ──→  POST /webhook/keeperhub
        │
        ▼
  This Backend
  ├── decode event + fetch merkleRoot via RPC
  ├── persist to SQLite
  └── POST merchant_webhook_url
        ├── channel_opened / channel_redeemed / channel_reclaimed
        └── payment_received  (x402 — with full proof for self-verification)
```

## Why x402 + RootPay beats standard x402

| | Standard x402 | RootPay x402 |
|---|---|---|
| Per-request cost | 1 on-chain tx | 0 (off-chain proof, ~1ms) |
| Settlement | Per call | Once per session |
| 1024 API calls | 1024 txs | 1 tx |
| Trust model | On-chain | Off-chain + verifiable |

## Running

```bash
cp .env.example .env
npm install
npm run dev
```

## Environment

```
PORT=3000
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
ROOTPAY_CONTRACT_ADDRESS=0x...
KEEPERHUB_WEBHOOK_SECRET=
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Status check |
| `POST` | `/webhook/keeperhub` | KeeperHub event receiver |
| `GET` | `/channels/:merchant` | All channels for a merchant |
| `GET` | `/channels/:payer/:merchant/:token` | Specific channel state |
| `GET` | `/channels?merchant=0x...` | Event log for merchant |
| `POST` | `/merchants/webhook` | Register merchant notification URL |
| `GET` | `/merchants/:address/webhook` | Check registered URL |
| `GET` | `/api/data` | x402-protected endpoint |

## KeeperHub setup

Configure a workflow to watch `ROOTPAY_CONTRACT_ADDRESS` on Base Sepolia for all 4 events and POST the decoded payload to:

```
POST https://<host>/webhook/keeperhub
```

## Merchant webhook payloads

**channel_opened**
```json
{ "event": "channel_opened", "payer": "0x...", "amount": "100000000000000000", "treeSize": 1024, "txHash": "0x..." }
```

**channel_redeemed**
```json
{ "event": "channel_redeemed", "amountPaid": "70000000000000000", "leafIndex": 716, "txHash": "0x..." }
```

**channel_reclaimed**
```json
{ "event": "channel_reclaimed", "payer": "0x...", "txHash": "0x..." }
```

**payment_received** — x402. Includes the raw proof so merchants can verify independently without trusting this backend:
```json
{
  "event": "payment_received",
  "ourAssessment": "valid",
  "leafIndex": 5,
  "leafValue": "97656250000000000",
  "proof": {
    "secret": "0x...",
    "siblings": ["0x...", "0x..."],
    "merkleRoot": "0x..."
  },
  "contract": {
    "address": "0x...",
    "function": "verifyMerkleProof(bytes32,uint16,bytes32,bytes32[]) → bool"
  },
  "selfVerify": {
    "step1": "leaf = keccak256(abi.encode(leafIndex, secret))",
    "step2": "walk proof: if index%2==0 → hash(current,sibling) else hash(sibling,current)",
    "step3": "result must equal merkleRoot"
  }
}
```

`ourAssessment` is advisory. The `merkleRoot` is committed on-chain at channel creation — verification is pure math.

## Tests

```bash
npm test
```
