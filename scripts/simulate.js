import assert from 'node:assert/strict';
import { harness } from '../test/helpers.js';

const f = await harness();
try {
  assert.equal((await f.subscribe()).status, 200);
  assert.equal((await f.receiveLark()).body.outcome, 'queued');
  assert.equal((await f.receiveLark()).body.outcome, 'duplicate');
  await f.app.bridge.tick();
  assert.equal(f.deliveries.length, 1);
  assert.equal((await f.reply(f.deliveries[0].data.message_id, '4')).body.result.structuredContent.status, 'pending');
  await f.app.bridge.tick();
  assert.equal((await f.reply()).body.result.structuredContent.status, 'sent');
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].url, 'https://open.feishu.cn/open-apis/im/v1/messages/fixture-message-1/reply');
  process.stdout.write(JSON.stringify({ mode: 'OFFLINE_SIMULATION', current_dot_connected: false, real_lark_connected: false,
    real_websocket_connected: false, official_sdk_dispatcher_used: true, local_http_mcp_used: true,
    events_delivered: f.deliveries.length, lark_replies: f.sends.length, same_conversation: true,
    reply_text_source: 'fixed_test_fixture' }, null, 2) + '\n');
} finally { await f.close(); }
