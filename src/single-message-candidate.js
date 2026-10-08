import { createVerifiedLarkDispatcher } from './lark-runtime.js';
import { ownerPrivateText } from './lark.js';
import { identity } from './credentials.js';
import { plainText, hash } from './common.js';

// Offline candidate only: deliberately not imported by any service/CLI. Its
// caller must separately establish approved identity, callback and transport.
export function createSingleMessageCandidate({ binding, expectedText, acceptAnyOwnerText = false, fixedReply, durationMs = 300000, waitForOwner = false, restoredState, clock = Date.now, sdk } = {}) {
  if (!binding || !/^cli_[0-9a-fA-F]{16}$/.test(binding.larkAppId || '') ||
      !['ownerOpenId','tenantKey','ownerChatId'].every(k => identity(binding[k])) ||
      !Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 900000) throw new Error('Invalid one-message candidate boundary');
  if (acceptAnyOwnerText !== true) plainText(expectedText); plainText(fixedReply);
  const config = Object.freeze({ larkAppId: binding.larkAppId, ownerOpenId: binding.ownerOpenId,
    tenantKey: binding.tenantKey, ownerChatId: binding.ownerChatId, replyTtlMs: durationMs });
  // Waiting for the owner may be open-ended. Once accepted, the message's own
  // timestamp-based reply window still bounds every event and reply operation.
  const started = clock(), deadline = waitForOwner === true ? Infinity : started + durationMs;
  let state = 'waiting', message, eventId;
  if(restoredState){
    const phases={waiting:'waiting',event_delivered:'event_delivered',sent:'sent',uncertain:'uncertain',cancelled:'cancelled'};
    if(!Object.hasOwn(phases,restoredState.phase))throw new Error('Invalid restored owner state');
    state=phases[restoredState.phase];
    if(restoredState.message){
      const saved=restoredState.message;
      if(typeof saved.id!=='string'||typeof saved.sourceEventId!=='string'||!Number.isFinite(Date.parse(saved.timestamp))||!Number.isSafeInteger(saved.expires)||saved.eventId!==`evt_${hash(`${config.larkAppId}:${saved.id}`)}`)throw new Error('Invalid restored message metadata');
      message=Object.freeze({id:saved.id,sourceEventId:saved.sourceEventId,timestamp:saved.timestamp,expires:saved.expires,owner:config.ownerOpenId,tenantKey:config.tenantKey,chatId:config.ownerChatId,text:null});eventId=saved.eventId;
    }
    if((state==='waiting')!==!message&&state!=='cancelled')throw new Error('Invalid restored message phase');
  }
  const active = () => {
    if (clock() >= Math.min(deadline, message?.expires ?? Infinity) && !['sent','uncertain','dead','cancelled'].includes(state)) state = 'expired';
    return !['sent','uncertain','dead','cancelled','expired'].includes(state);
  };
  const dispatcher = createVerifiedLarkDispatcher(config, async data => {
    if (!active()) return { outcome: 'closed' };
    let incoming;
    try { incoming = ownerPrivateText(data, config, clock()); } catch { return { outcome: 'rejected' }; }
    if (!incoming || (acceptAnyOwnerText !== true && incoming.text !== expectedText) || Date.parse(incoming.timestamp) < started) return { outcome: 'rejected' };
    if (state !== 'waiting') return { outcome: message?.id === incoming.id && message?.sourceEventId === incoming.sourceEventId ? 'duplicate' : 'budget_exhausted' };
    message = Object.freeze(incoming); eventId = `evt_${hash(`${config.larkAppId}:${message.id}`)}`; state = 'accepted';
    return { outcome: 'accepted' };
  }, { ...(sdk ? { sdk } : {}), report() {} });
  return Object.freeze({
    dispatcher,
    claimEvent() {
      if (!active() || state !== 'accepted') return null;
      state = 'event_claimed';
      return { eventId, name: 'lark.message.created', timestamp: message.timestamp,
        data: { message_id: message.id, conversation: 'owner', text: message.text, reply_deadline: new Date(Math.min(deadline, message.expires)).toISOString() }, cursor: null };
    },
    finishEvent(id, outcome) {
      if (!active() || state !== 'event_claimed' || id !== eventId || !['delivered','uncertain','dead'].includes(outcome)) return false;
      state = outcome === 'delivered' ? 'event_delivered' : outcome; return true;
    },
    checkpointMessage() {return message?{id:message.id,sourceEventId:message.sourceEventId,eventId,timestamp:message.timestamp,expires:message.expires}:null;},
    pendingMessage() {
      if (!active() || state !== 'event_delivered') return null;
      return { message_id: message.id, reply_deadline: new Date(Math.min(deadline,message.expires)).toISOString() };
    },
    readMessage(messageId) {
      if (!active() || !['event_delivered','reply_claimed'].includes(state) || messageId !== message?.id) return null;
      return {message_id:message.id,text:message.text,reply_deadline:new Date(Math.min(deadline,message.expires)).toISOString()};
    },
    claimReply(messageId, text) {
      if (!active() || state !== 'event_delivered' || messageId !== message.id || text !== fixedReply) return null;
      state = 'reply_claimed';
      return { message: { id: message.id, owner: config.ownerOpenId, tenant_key: config.tenantKey,
        chat_id: config.ownerChatId, expires: Math.min(deadline, message.expires) }, text: fixedReply };
    },
    authorizeReply() { return active() && state === 'reply_claimed'; },
    finishReply(outcome) {
      if (!active() || state !== 'reply_claimed' || !['sent','uncertain','dead'].includes(outcome)) return false;
      state = outcome; return true;
    },
    cancel() { if (active()) state = 'cancelled'; },
    status() { active(); return { state, incoming_claimed: !!message, max_incoming: 1, max_events: 1, max_reply_attempts: 1,
      production_ready: false, final_destination_ip_verified: false }; }
  });
}
