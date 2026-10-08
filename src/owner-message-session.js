import { randomBytes } from 'node:crypto';
import { createSingleMessageCandidate } from './single-message-candidate.js';
import { createLarkSender } from './lark.js';
import { destinationUrl } from './network.js';
import { webhookHeaders, webhookKey } from './signatures.js';
import { validateCredentials } from './credentials.js';
import { equal } from './common.js';

// Isolated, code-injected review candidate. Ordinary Bridge, service and callback
// readiness are deliberately unchanged. No file reads, listeners or WS startup.
export function createLarkOwnerMessageSession({ credentials, expectedAppId, expectedText, acceptAnyOwnerText = false, fixedReply, callbackHosts = [], authenticatedCallbackDiscovery = false,
  callbackTransport, recognizeTransport, proxyEnv, providerSend, deadlineMs, waitForOwner = false, clock = Date.now, sdk } = {}) {
  validateCredentials(credentials, { paired: true });
  if (typeof waitForOwner !== 'boolean' || credentials.appId !== expectedAppId || !Array.isArray(callbackHosts) || (!callbackHosts.length && authenticatedCallbackDiscovery !== true) ||
      typeof callbackTransport !== 'function' || typeof recognizeTransport !== 'function' || typeof providerSend !== 'function' ||
      (waitForOwner !== true && (!Number.isSafeInteger(deadlineMs) || deadlineMs <= clock() || deadlineMs > clock() + 900000))) throw new Error('Invalid isolated owner-message session');
  const config = Object.freeze({ larkAppId: credentials.appId, larkAppSecret: credentials.appSecret,
    ownerOpenId: credentials.ownerOpenId, tenantKey: credentials.tenantKey, ownerChatId: credentials.ownerChatId });
  const gate = createSingleMessageCandidate({ binding: config, expectedText, acceptAnyOwnerText, fixedReply, durationMs: waitForOwner ? 300000 : deadlineMs-clock(), waitForOwner, clock, sdk });
  const replySender = createLarkSender(config, providerSend, clock);
  let subscription, phase='awaiting_subscription', revoked=false,subscriptionTimer,replyDeadline;
  const scopeDeadline = () => Math.min(waitForOwner ? Infinity : deadlineMs, subscription?.validUntil ?? Infinity, replyDeadline ?? Infinity);
  const armExpiry = () => {clearTimeout(subscriptionTimer);subscriptionTimer=setTimeout(()=>{if(waitForOwner&&!gate.status().incoming_claimed&&!revoked)phase='awaiting_renewal';else terminate();},Math.max(1,scopeDeadline()-clock()));subscriptionTimer.unref?.();};
  const terminate=()=>{clearTimeout(subscriptionTimer);revoked=true;gate.cancel();phase='closed';callbackTransport.close?.();providerSend.close?.();};
  function authorize() {
    const status = recognizeTransport(callbackTransport, proxyEnv);
    if (revoked || clock() >= scopeDeadline() || !status || status.mode !== 'owner_single_message_proxy' || status.ready !== true ||
      (subscription && subscription.validUntil <= clock())) throw new Error('Owner-message experiment authorization inactive');
  }
  return Object.freeze({
    async subscribe({ url, secret }, principal) {
      if (revoked || principal?.id !== 'tunnel-owner:dot-bridge' || !Number.isFinite(principal.validUntil) || principal.validUntil <= clock()) throw new Error('Authenticated owner subscription required');
      const selectedHosts=callbackHosts.length?callbackHosts:[new URL(url).hostname];
      destinationUrl(url,selectedHosts);webhookKey(secret);
      if(subscription){
        if(waitForOwner!==true||!['subscribed','awaiting_renewal'].includes(phase)||gate.status().incoming_claimed||url!==subscription.url||!equal(secret,subscription.secret))throw new Error('Subscription renewal refused');
        callbackTransport.renewLease(principal.validUntil);
        subscription.validUntil=principal.validUntil;authorize();phase='subscribed';armExpiry();
        return {id:subscription.id,refreshBefore:new Date(subscription.validUntil).toISOString()};
      }
      if(phase!=='awaiting_subscription')throw new Error('Subscription unavailable');
      if(waitForOwner)callbackTransport.renewLease(principal.validUntil);
      subscription={id:`sub_${randomBytes(32).toString('hex')}`,url,secret,hosts:selectedHosts,validUntil:Math.min(waitForOwner?Infinity:deadlineMs,principal.validUntil)};
      authorize();armExpiry();
      phase='verifying';const challenge=randomBytes(32).toString('base64url'),body=Buffer.from(JSON.stringify({type:'verification',challenge}));
      try {
        const response=await callbackTransport(url,{method:'POST',hosts:subscription.hosts,headers:webhookHeaders(subscription,`verify_${randomBytes(16).toString('hex')}`,body,clock()),body,beforeConnect:authorize});
        authorize();const echoed=JSON.parse(response.body.toString());
        if(response.status<200||response.status>=300||typeof echoed.challenge!=='string'||!equal(echoed.challenge,challenge))throw Error();
        phase='subscribed';return {id:subscription.id,refreshBefore:new Date(subscription.validUntil).toISOString()};
      }catch{terminate();throw new Error('Owner-message callback verification failed');}
    },
    async receive(envelope) {
      authorize();if(phase!=='subscribed')return {outcome:'closed'};
      const outcome=await gate.dispatcher.invoke(envelope,{needCheck:false});
      const event=gate.claimEvent();if(!event)return outcome;
      replyDeadline=Date.parse(event.data.reply_deadline);armExpiry();phase='event_claimed';const body=Buffer.from(JSON.stringify(event));
      try {
        const response=await callbackTransport(subscription.url,{method:'POST',hosts:subscription.hosts,headers:webhookHeaders(subscription,event.eventId,body,clock()),body,beforeConnect:authorize});
        authorize();if(response.status<200||response.status>=300)throw Error();
        gate.finishEvent(event.eventId,'delivered');phase='awaiting_fixed_reply';return {outcome:'delivered'};
      }catch{gate.finishEvent(event.eventId,'uncertain');terminate();return {outcome:'uncertain'};}
    },
    setup(callbackUrl) {
      let callback_hostname=null,callback_policy='not_provided';
      if(callbackUrl!==undefined){callback_policy='invalid';try{const candidate=new URL(callbackUrl);destinationUrl(callbackUrl,[candidate.hostname]);callback_hostname=candidate.hostname;callback_policy=subscription?.url===candidate.href?'allowlisted':'not_allowlisted';}catch{}}
      const callback_transport=recognizeTransport(callbackTransport,proxyEnv);
      const pending_message=!revoked&&clock()<scopeDeadline()&&callback_transport?.ready===true?gate.pendingMessage():null;
      return {...(callback_transport?.mode==='owner_single_message_proxy'?{pending_message}:{}),callback_transport,callback_hostname,callback_policy,binding_ready:true,delivery_configured:!revoked&&!!subscription&&subscription.validUntil>clock(),network_checked:false};
    },
    readMessage(messageId,principal) {
      authorize();if(principal?.id!=='tunnel-owner:dot-bridge'||!Number.isFinite(principal.validUntil)||principal.validUntil<=clock())throw new Error('Authenticated owner required');
      const value=gate.readMessage(messageId);if(!value)throw new Error('Test message unavailable');return {...value,reply:{message_id:messageId,status:gate.status().state==='reply_claimed'?'processing':'none',error:null}};
    },
    unsubscribe(url,principal) {
      if(principal?.id!=='tunnel-owner:dot-bridge'||!Number.isFinite(principal.validUntil)||principal.validUntil<=clock()||url!==subscription?.url)throw new Error('Subscription unavailable');
      terminate();
    },
    async reply(messageId,text,principal) {
      authorize();if(principal?.id!=='tunnel-owner:dot-bridge'||!Number.isFinite(principal.validUntil)||principal.validUntil<=clock()||phase!=='awaiting_fixed_reply')throw new Error('Fixed reply unavailable');
      const claim=gate.claimReply(messageId,text);if(!claim)throw new Error('Fixed reply unavailable');phase='reply_claimed';
      try {
        await replySender(claim.message,claim.text,{authorize(){authorize();if(!gate.authorizeReply())throw new Error('Reply budget inactive');}});
        authorize();if(!gate.authorizeReply())throw new Error('Reply scope ended');
        gate.finishReply('sent');phase='closed';return {status:'sent'};
      }catch{gate.finishReply('uncertain');phase='closed';return {status:'uncertain'};}
    },
    expiresAt:scopeDeadline,
    close:terminate,
    status(){return {phase,...gate.status(),ordinary_callback_ready:false,final_destination_ip_verified:false,live_validation_performed:false};}
  });
}
