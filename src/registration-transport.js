import https from 'node:https';
import { createProviderProxyAgent } from './provider-network.js';

const ENDPOINT = 'https://accounts.feishu.cn/oauth/v1/app/registration';
const refused = code => Object.assign(new Error('Official registration transport failed'), { code });

// For a dedicated registration subprocess only: install as the pinned SDK's
// defaultHttpInstance.post. Never change the shared SDK transport in a bridge.
// No new external dependency, no proxy bypass, no redirects, fixed TLS name.
export function makeRegistrationPost({ env = process.env, request = https.request, timeoutMs = 15000,
  agentFactory = createProviderProxyAgent, report = () => {} } = {}) {
  let requests = 0;
  return async (url, body) => {
    if (url !== ENDPOINT || typeof body !== 'string' || Buffer.byteLength(body) > 8192) throw refused('registration_target_refused');
    const params = new URLSearchParams(body), keys = [...params.keys()];
    const begin = params.get('action') === 'begin';
    const allowed = begin ? ['action', 'archetype', 'auth_method', 'request_user_info'] : ['action', 'device_code'];
    if (new Set(keys).size !== keys.length || keys.length !== allowed.length || keys.some(key => !allowed.includes(key)) ||
        (begin ? params.get('archetype') !== 'PersonalAgent' || params.get('auth_method') !== 'client_secret' || params.get('request_user_info') !== 'open_id' :
          params.get('action') !== 'poll' || !params.get('device_code'))) throw refused('registration_parameters_refused');
    let agent;
    try { agent = agentFactory({ env, allowedHost: host => host === 'accounts.feishu.cn' }); }
    catch { throw refused('registration_proxy_refused'); }
    // This runner is cloud-proxy-only. Absence or refusal never falls back.
    if (!agent) throw refused('registration_proxy_required');
    const requestNumber = ++requests, started = Date.now();
    report({ phase: 'registration_http_started', action: begin ? 'begin' : 'poll', request_number: requestNumber, at: new Date(started).toISOString() });
    try {
      return await new Promise((resolve, reject) => {
        let req, timer, settled = false;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
        try {
          req = request(ENDPOINT, { method: 'POST', agent, rejectUnauthorized: true, servername: 'accounts.feishu.cn',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, response => {
            // No response payload, identity or device code ever reaches logs.
            report({ phase: 'registration_http', action: begin ? 'begin' : 'poll', status: response.statusCode, request_number: requestNumber, elapsed_ms: Date.now() - started, at: new Date().toISOString() });
            if (![200, 400].includes(response.statusCode)) { response.destroy(); finish(refused('registration_http_refused')); return; }
            const chunks = []; let bytes = 0;
            response.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) { response.destroy(); finish(refused('registration_response_limit')); } else chunks.push(chunk); });
            response.on('error', () => finish(refused('registration_response_failed')));
            response.on('aborted', () => finish(refused('registration_response_failed')));
            response.on('end', () => {
              try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); finish(null, value); }
              catch { finish(refused('registration_response_invalid')); }
            });
          });
        } catch { finish(refused('registration_connection_refused')); return; }
        timer = setTimeout(() => { req.destroy(); finish(refused('registration_timeout')); }, timeoutMs);
        req.on('error', () => finish(refused('registration_connection_refused')));
        req.end(body);
      });
    } finally { agent.destroy(); }
  };
}
