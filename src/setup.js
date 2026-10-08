import * as lark from '@larksuiteoapi/node-sdk';
import { randomBytes } from 'node:crypto';
import { identity, validateCredentials } from './credentials.js';
import { assertPrivateDestination, writePrivateJson } from './private-files.js';
import { createLarkConnection, createVerifiedLarkDispatcher } from './lark-runtime.js';
import { ownerPrivateText } from './lark.js';

export const REGISTRATION_ADDONS = Object.freeze({ preset: false,
  scopes: Object.freeze({ tenant: Object.freeze(['im:message.p2p_msg:readonly', 'im:message:send_as_bot']) }),
  events: Object.freeze({ items: Object.freeze({ tenant: Object.freeze(['im.message.receive_v1']) }) }) });
export function setupPlan() {
  return { mode: 'PLAN_ONLY', network: false, credentials_created: false, permissions: REGISTRATION_ADDONS,
    required_approvals: ['Create one Feishu app in the approved tenant; owner scans the official confirmation page',
      'Save app credentials and the verified owner binding at approved private paths; read app status and pair via WSS',
      'Main thread selects cloud hosting, owner OAuth issuer and current-dot plugin subscription before live service'],
    missing_identity_policy: 'deny', no_user_token_or_cookie: true };
}
function cancelled() { const error = new Error('Operator flow cancelled'); error.code = 'abort'; return error; }
function checkSignal(signal) { if (signal?.aborted) throw cancelled(); }
export async function registerFeishu({ credentialsFile, tenantKey, confirmed = false, signal, report = () => {}, sdk = lark,
  timeoutMs = 10 * 60000, clock = Date.now, save = writePrivateJson }) {
  if (!confirmed) throw new Error('App creation requires prior main-thread approval and --confirm-create-app');
  if (!identity(tenantKey)) throw new Error('An explicitly approved tenant key is required');
  assertPrivateDestination(credentialsFile); checkSignal(signal);
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let rejectAbort;
  const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
  controller.signal.addEventListener('abort', () => rejectAbort(cancelled()), { once: true });
  try {
    const result = await Promise.race([sdk.registerApp({ domain: 'accounts.feishu.cn', createOnly: true,
      source: 'dot-lark-bridge', addons: REGISTRATION_ADDONS, signal: controller.signal,
      onQRCodeReady(info) {
        const url = new URL(info.url);
        if (url.protocol !== 'https:' || !['accounts.feishu.cn', 'open.feishu.cn'].includes(url.hostname) || url.username || url.password || url.hash ||
            (url.port && url.port !== '443') || !Number.isFinite(info.expireIn) || info.expireIn <= 0) {
          controller.abort(); return;
        }
        // Only this short-lived official confirmation URL is shown locally.
        report({ phase: 'awaiting_owner_confirmation', verification_url: url.href, expires_in_seconds: info.expireIn });
      },
      onStatusChange(info) {
        if (info.status === 'domain_switched') { controller.abort(); report({ phase: 'unsupported_tenant_brand' }); }
        else if (['polling', 'slow_down'].includes(info.status)) report({ phase: info.status });
      }
    }), interrupted]);
    checkSignal(controller.signal);
    if (result.user_info?.tenant_brand && result.user_info.tenant_brand !== 'feishu') throw new Error('Only Feishu is supported');
    const credentials = validateCredentials({ version: 1, status: 'registered', appId: result.client_id, appSecret: result.client_secret,
      tenantKey, ...(result.user_info?.open_id ? { ownerOpenId: result.user_info.open_id } : {}), registeredAt: new Date(clock()).toISOString() });
    save(credentialsFile, credentials);
    const status = { phase: 'app_credentials_saved', owner_candidate_available: Boolean(credentials.ownerOpenId),
      owner_binding_complete: false, current_dot_connected: false };
    report(status); return status;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function pairingConfig(credentials, ownerOpenId, timeoutMs) {
  validateCredentials(credentials);
  if (credentials.status !== 'registered') throw new Error('Only unpaired credentials may be paired');
  if (ownerOpenId && credentials.ownerOpenId && ownerOpenId !== credentials.ownerOpenId) throw new Error('Approved owner conflicts with scanning user');
  const owner = ownerOpenId || credentials.ownerOpenId;
  if (!identity(owner)) throw new Error('Verified owner open_id required; first sender is never trusted');
  return { larkAppId: credentials.appId, larkAppSecret: credentials.appSecret, tenantKey: credentials.tenantKey,
    ownerOpenId: owner, replyTtlMs: timeoutMs };
}
export function createPairingSession(credentials, { ownerOpenId, sdk = lark, clock = Date.now, timeoutMs = 5 * 60000,
  nonce = randomBytes(24).toString('base64url'), report = () => {} } = {}) {
  const config = pairingConfig(credentials, ownerOpenId, timeoutMs), owner = config.ownerOpenId;
  const started = clock(), expires = started + timeoutMs, text = `pair ${nonce}`;
  let resolved = false, resolve;
  const completion = new Promise(done => { resolve = done; });
  const dispatcher = createVerifiedLarkDispatcher(config, async data => {
    if (resolved || clock() >= expires) return { outcome: 'ignored' };
    try {
      // The chat is learned only after the known owner, tenant, source and fresh
      // exact challenge are verified. No other message is stored or forwarded.
      if (!identity(data.message?.chat_id)) return { outcome: 'rejected' };
      const message = ownerPrivateText(data, { ...config, ownerChatId: data.message.chat_id }, clock());
      if (!message || message.text !== text || Date.parse(message.timestamp) < started - 30000) return { outcome: 'ignored' };
      resolved = true;
      resolve(validateCredentials({ ...credentials, status: 'paired', ownerOpenId: owner, ownerChatId: message.chatId,
        pairedAt: new Date(clock()).toISOString() }, { paired: true }));
      return { outcome: 'paired' };
    } catch { report({ phase: 'pairing_message_rejected' }); return { outcome: 'rejected' }; }
  }, { sdk, report: () => report({ phase: 'pairing_message_rejected' }) });
  return { config, dispatcher, completion, challenge: text, expires, cancel() { resolved = true; } };
}

async function pairWithSession({ credentials, bindingFile, ownerOpenId, confirmed = false, signal, sdk = lark,
  report = () => {}, timeoutMs = 5 * 60000, connectionTimeoutMs = 60000,
  connectionFactory = createLarkConnection, save = writePrivateJson, clock = Date.now }, { configFactory, sessionFactory }) {
  if (!confirmed) throw new Error('Owner pairing requires prior main-thread approval and --confirm-bind');
  assertPrivateDestination(bindingFile); checkSignal(signal);
  if (![timeoutMs, connectionTimeoutMs].every(value => Number.isFinite(value) && value > 0 && value <= 2147483647)) {
    throw new Error('Pairing and connection timeouts must be finite positive durations');
  }
  const config = configFactory(credentials, ownerOpenId, timeoutMs);
  let session, connection, connectionTimer, pairingTimer, rejectAbort, resolveReady, stopped = false, failure;
  const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
  // A synchronous factory failure may exit before the main race is installed.
  interrupted.catch(() => {});
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const fail = error => {
    if (stopped || failure) return;
    failure = error; session?.cancel(); rejectAbort(error);
  };
  const abort = () => fail(cancelled());
  // The SDK's start() can finish before WSS connects. Discard every message
  // until its authenticated onReady callback reports lark_connected.
  const dispatcher = { async invoke(...args) {
    if (stopped || failure || !session) return { outcome: 'ignored' };
    return session.dispatcher.invoke(...args);
  } };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    checkSignal(signal);
    connectionTimer = setTimeout(() => fail(new Error('Pairing connection timed out before readiness')), connectionTimeoutMs);
    connection = connectionFactory(config, dispatcher, { sdk, report: event => {
      if (stopped || failure) return;
      try {
        if (['lark_connected', 'lark_reconnected', 'lark_connection_failed'].includes(event)) report({ phase: event });
        if (event !== 'lark_connected' || session) return;
        checkSignal(signal); clearTimeout(connectionTimer);
        session = sessionFactory(credentials, { ownerOpenId, sdk, clock, timeoutMs, report });
        pairingTimer = setTimeout(() => fail(new Error('Pairing challenge expired')), timeoutMs);
        report(session.acceptsAnyPlainText ? { phase: 'owner_message_ready', expires_in_seconds: timeoutMs / 1000 } : { phase: 'pairing_challenge', private_text_to_send: session.challenge, expires_in_seconds: timeoutMs / 1000 });
        resolveReady();
      } catch (error) { fail(error); }
    } });
    // Observe late startup failures too, without treating a resolved start as
    // readiness or allowing a hung start to defeat cancellation and timeouts.
    Promise.resolve().then(() => { if (!failure && !stopped) return connection.start(); }).catch(fail);
    await Promise.race([ready, interrupted]);
    const paired = await Promise.race([session.completion, interrupted]); checkSignal(signal);
    if (failure) throw failure;
    save(bindingFile, paired);
    const status = { phase: 'owner_private_chat_bound', owner_binding_complete: true, bridge_started: false, current_dot_connected: false };
    report(status); return status;
  } finally {
    stopped = true; clearTimeout(connectionTimer); clearTimeout(pairingTimer);
    signal?.removeEventListener('abort', abort); session?.cancel(); connection?.close();
  }
}

export function pairFeishu(options) {
  return pairWithSession(options, { configFactory: pairingConfig, sessionFactory: createPairingSession });
}
function scannedOwnerConfig(credentials, _owner, timeoutMs) {
  validateCredentials(credentials);
  if(credentials.status !== 'unbound' || !identity(credentials.ownerOpenId)) throw new Error('Official scanned-owner binding required');
  return {larkAppId:credentials.appId,larkAppSecret:credentials.appSecret,ownerOpenId:credentials.ownerOpenId,replyTtlMs:timeoutMs};
}
export const SCANNED_OWNER_TEST_TEXT = '飞书 单条连接测试';
function createScannedOwnerSession(credentials,{sdk=lark,clock=Date.now,timeoutMs=300000,nonce=randomBytes(24).toString('base64url'),report=()=>{}}={},testMessage=false) {
  const config=scannedOwnerConfig(credentials,undefined,timeoutMs),started=clock(),expires=started+timeoutMs,challenge=testMessage?SCANNED_OWNER_TEST_TEXT:`pair ${nonce}`;
  let settled=false,resolve;const completion=new Promise(done=>{resolve=done;});
  const count=classification=>{try{report({phase:'owner_binding_event',classification});}catch{}};
  const reject=classification=>{count(classification);return {outcome:'rejected'};};
  const dispatcher={async invoke(envelope,params){
    if(settled||clock()>=expires){count('closed');return {outcome:'ignored'};}
    // Called exclusively by the authenticated official app WSClient. Never bind
    // from an HTTP payload, an unknown first sender or an SDK-merged header.
    if(params?.needCheck!==false||envelope?.schema!=='2.0'||!envelope.header||!envelope.event||
       ['app_id','tenant_key','event_id','event_type','create_time','schema'].some(k=>Object.hasOwn(envelope.event,k)))return reject('envelope_rejected');
    const h=envelope.header,e=envelope.event;
    if(h.app_id!==credentials.appId||h.event_type!=='im.message.receive_v1')return reject('app_or_event_rejected');
    if(e.sender?.sender_type!=='user'||e.sender?.sender_id?.open_id!==credentials.ownerOpenId)return reject('owner_rejected');
    if(!identity(h.tenant_key)||e.sender?.tenant_key!==h.tenant_key)return reject('tenant_rejected');
    if(!identity(e.message?.chat_id)||e.message?.chat_type!=='p2p')return reject('conversation_rejected');
    const verified={...config,tenantKey:h.tenant_key,ownerChatId:e.message.chat_id};
    const strict=createVerifiedLarkDispatcher(verified,async data=>{
      try{
        const message=ownerPrivateText(data,verified,clock());
        if(!message)return reject('message_type_rejected');
        if((!testMessage&&message.text!==challenge)||Date.parse(message.timestamp)<(testMessage?started:started-30000)||settled||clock()>=expires)return reject('freshness_or_challenge_rejected');
        settled=true;resolve(validateCredentials({...credentials,status:'paired',tenantKey:h.tenant_key,ownerChatId:message.chatId,pairedAt:new Date(clock()).toISOString()},{paired:true}));
        count('accepted');return {outcome:'paired'};
      }catch{return reject('message_validation_rejected');}
    },{sdk,report(){}});
    return strict.invoke(envelope,params);
  }};
  return {config,dispatcher,completion,challenge,expires,acceptsAnyPlainText:testMessage,cancel(){settled=true;}};
}
export function createScannedOwnerPairingSession(credentials,options) { return createScannedOwnerSession(credentials,options,false); }
export function createScannedOwnerTestMessageSession(credentials,options) { return createScannedOwnerSession(credentials,options,true); }
function validateScannedOwnerOptions(options) {
  if(options?.confirmed!==true||options.expectedAppId!==options.credentials?.appId||!/^cli_[a-fA-F0-9]{16}$/.test(options.expectedAppId)||
     (options.ownerOpenId!==undefined&&options.ownerOpenId!==options.credentials.ownerOpenId)||
     (options.timeoutMs!==undefined&&(options.timeoutMs<1||options.timeoutMs>300000))||
     (options.connectionTimeoutMs!==undefined&&(options.connectionTimeoutMs<1||options.connectionTimeoutMs>60000)))throw new Error('Explicit bounded scanned-owner pairing required');
}
export function pairScannedOwner(options) {
  validateScannedOwnerOptions(options);
  return pairWithSession(options,{configFactory:scannedOwnerConfig,sessionFactory:createScannedOwnerPairingSession});
}
export function pairScannedOwnerTestMessage(options) {
  validateScannedOwnerOptions(options);
  return pairWithSession(options,{configFactory:scannedOwnerConfig,sessionFactory:createScannedOwnerTestMessageSession});
}
