import https from 'node:https';
import { makeProviderRequester } from './provider-network.js';

// Candidate-only cancellation wrapper around the existing forced provider proxy
// implementation. No new proxy route, hostname allowance or TLS exception.
export function makeOwnerMessageProvider({proxyEnv=process.env,deadlineMs,clock=Date.now,request=https.request,agentFactory}={}){
 if(!Number.isSafeInteger(deadlineMs)||deadlineMs<=clock()||deadlineMs>clock()+900000)throw new Error('Bounded provider deadline required');
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Math.max(1,deadlineMs-clock()));timer.unref?.();
 const active=()=>{if(controller.signal.aborted||clock()>=deadlineMs)throw new Error('Owner test provider scope expired');};
 const core=makeProviderRequester({env:proxyEnv,...(agentFactory?{agentFactory}:{}),request:(url,options,receive)=>{active();return request(url,{...options,signal:controller.signal},receive);}});
 const send=(url,options)=>{
  active();if(options.purpose!=='provider')throw new Error('Provider-only candidate sender');
  return core(url,{...options,beforeConnect(){active();options.beforeConnect?.();active();}});
 };
 Object.defineProperty(send,'close',{value:()=>{clearTimeout(timer);controller.abort();}});return send;
}
