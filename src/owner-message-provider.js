import https from 'node:https';
import { makeProviderRequester } from './provider-network.js';

// Candidate-only cancellation wrapper around the existing forced provider proxy
// implementation. No new proxy route, hostname allowance or TLS exception.
export function makeOwnerMessageProvider({proxyEnv=process.env,deadlineMs,clock=Date.now,request=https.request,agentFactory}={}){
 if(deadlineMs!==undefined&&(!Number.isSafeInteger(deadlineMs)||deadlineMs<=clock()||deadlineMs>clock()+900000))throw new Error('Valid optional provider deadline required');
 // An omitted overall deadline waits for lifecycle cancellation. The core
 // requester keeps its independent per-request timeout and authorization gate.
 const controller=new AbortController();const timer=deadlineMs===undefined?undefined:setTimeout(()=>controller.abort(),Math.max(1,deadlineMs-clock()));timer?.unref?.();
 const active=()=>{if(controller.signal.aborted||(deadlineMs!==undefined&&clock()>=deadlineMs))throw new Error('Owner test provider scope expired');};
 const send=(url,options)=>{
  active();if(options.purpose!=='provider')throw new Error('Provider-only candidate sender');
  const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
  const scopedActive=()=>{active();if(signal.aborted)throw new Error('Provider request scope cancelled');};
  const core=makeProviderRequester({env:proxyEnv,...(agentFactory?{agentFactory}:{}),request:(target,requestOptions,receive)=>{scopedActive();return request(target,{...requestOptions,signal},receive);}});
  return core(url,{...options,beforeConnect(){scopedActive();options.beforeConnect?.();scopedActive();}});
 };
 Object.defineProperty(send,'close',{value:()=>{clearTimeout(timer);controller.abort();}});return send;
}
