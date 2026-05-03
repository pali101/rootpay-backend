import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { decodeKeeperHubPayload } from '../src/decoder.js';

const PAYER    = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const MERCHANT = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const TOKEN    = '0x0000000000000000000000000000000000000000';
const TX_HASH  = '0xabc123';

describe('decodeKeeperHubPayload — pre-decoded format', () => {
  test('ChannelCreated', () => {
    const evt = decodeKeeperHubPayload({
      event: 'ChannelCreated',
      transactionHash: TX_HASH,
      blockNumber: 5000,
      args: {
        payer: PAYER,
        merchant: MERCHANT,
        token: TOKEN,
        amount: '1000000000000000000',
        treeSize: 1024,
        merchantWithdrawAfterBlocks: 5100,
      },
    });

    assert.equal(evt.type, 'ChannelCreated');
    assert.equal(evt.payer, PAYER.toLowerCase());
    assert.equal(evt.merchant, MERCHANT.toLowerCase());
    assert.equal(evt.token, TOKEN.toLowerCase());
    assert.equal(evt.amount, '1000000000000000000');
    assert.equal(evt.treeSize, 1024);
    assert.equal(evt.merchantWithdrawAfterBlock, 5100);
    assert.equal(evt.txHash, TX_HASH);
    assert.equal(evt.blockNumber, 5000);
  });

  test('ChannelRedeemed', () => {
    const evt = decodeKeeperHubPayload({
      event: 'ChannelRedeemed',
      transactionHash: TX_HASH,
      blockNumber: 5101,
      args: {
        payer: PAYER,
        merchant: MERCHANT,
        token: TOKEN,
        amountPaid: '700000000000000000',
        leafIndex: 716,
      },
    });

    assert.equal(evt.type, 'ChannelRedeemed');
    assert.equal(evt.amountPaid, '700000000000000000');
    assert.equal(evt.leafIndex, 716);
  });

  test('ChannelRefunded', () => {
    const evt = decodeKeeperHubPayload({
      event: 'ChannelRefunded',
      transactionHash: TX_HASH,
      blockNumber: 5101,
      args: {
        payer: PAYER,
        merchant: MERCHANT,
        token: TOKEN,
        refundAmount: '300000000000000000',
      },
    });

    assert.equal(evt.type, 'ChannelRefunded');
    assert.equal(evt.refundAmount, '300000000000000000');
  });

  test('ChannelReclaimed', () => {
    const evt = decodeKeeperHubPayload({
      event: 'ChannelReclaimed',
      transactionHash: TX_HASH,
      blockNumber: 6000,
      args: {
        payer: PAYER,
        merchant: MERCHANT,
        token: TOKEN,
        blockNumber: 6000,
      },
    });

    assert.equal(evt.type, 'ChannelReclaimed');
    assert.equal(evt.reclaimedAtBlock, 6000);
  });

  test('normalises addresses to lowercase', () => {
    const evt = decodeKeeperHubPayload({
      event: 'ChannelCreated',
      transactionHash: TX_HASH,
      blockNumber: 1,
      args: {
        payer: PAYER.toUpperCase(),
        merchant: MERCHANT.toUpperCase(),
        token: TOKEN,
        amount: '1',
        treeSize: 1,
        merchantWithdrawAfterBlocks: 100,
      },
    });
    assert.equal(evt.payer, PAYER.toLowerCase());
    assert.equal(evt.merchant, MERCHANT.toLowerCase());
  });

  test('throws on unknown event name', () => {
    assert.throws(() =>
      decodeKeeperHubPayload({
        event: 'UnknownEvent',
        transactionHash: TX_HASH,
        blockNumber: 1,
        args: { payer: PAYER, merchant: MERCHANT, token: TOKEN },
      }),
    );
  });
});

describe('decodeKeeperHubPayload — raw log format', () => {
  // Encode a ChannelCreated log manually using ethers so we can test the
  // raw-log decode path (topics + data).
  const iface = new ethers.Interface([
    'event ChannelCreated(address indexed payer, address indexed merchant, address token, uint256 amount, uint16 treeSize, uint64 merchantWithdrawAfterBlocks)',
  ]);

  const encoded = iface.encodeEventLog('ChannelCreated', [
    PAYER, MERCHANT, TOKEN,
    ethers.parseEther('1'),
    1024,
    5100n,
  ]);

  test('decodes raw log (topics + data)', () => {
    const evt = decodeKeeperHubPayload({
      topics: encoded.topics,
      data: encoded.data,
      transactionHash: TX_HASH,
      blockNumber: 5000,
    });

    assert.equal(evt.type, 'ChannelCreated');
    assert.equal(evt.payer, PAYER.toLowerCase());
    assert.equal(evt.merchant, MERCHANT.toLowerCase());
    assert.equal(evt.amount, ethers.parseEther('1').toString());
    assert.equal(evt.treeSize, 1024);
  });
});
