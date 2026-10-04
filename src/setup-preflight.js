import { callbackTransportStatusSchema } from '../../dot-qq-bridge/packages/dot-bridge-transport/index.js';
import { destinationUrl, safeCallbackTransportStatus } from './network.js';
export const larkSetupTool = {
 name: 'check_lark_setup', title: 'Check local Feishu bridge setup', description: 'Local policy inspection only; never resolves DNS, connects or changes callback permission.',
 inputSchema: {type:'object',properties:{callback_url:{type:'string',maxLength:2048}},additionalProperties:false},
 outputSchema: {type:'object',properties:{callback_transport:callbackTransportStatusSchema,callback_hostname:{type:['string','null']},callback_policy:{type:'string',enum:['not_provided','invalid','not_allowlisted','allowlisted']},binding_ready:{type:'boolean'},delivery_configured:{type:'boolean'},network_checked:{type:'boolean',const:false}},required:['callback_transport','callback_hostname','callback_policy','binding_ready','delivery_configured','network_checked'],additionalProperties:false},
 annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
};
export function callbackPreflight(config, bindingReady, callbackUrl, transport) {
 const callback_transport=safeCallbackTransportStatus(transport);
 let hostname=null, policy='not_provided';
 if (callbackUrl !== undefined) {
   policy='invalid';
   try {
     if (typeof callbackUrl !== 'string' || callbackUrl.length > 2048) throw new Error();
     const candidate=new URL(callbackUrl);destinationUrl(callbackUrl,[candidate.hostname]);hostname=candidate.hostname;
     policy=config.callbackHosts.includes(hostname)?'allowlisted':'not_allowlisted';
   } catch { /* Never expose input, including paths or embedded credentials. */ }
 }
 return {callback_transport,callback_hostname:hostname,callback_policy:policy,binding_ready:bindingReady,delivery_configured:bindingReady&&!!config.callbackHosts.length&&callback_transport.ready,network_checked:false};
}
