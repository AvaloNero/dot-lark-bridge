import { privateMkdtempSync, fixtureChmodSync, fixtureSymlinkSync } from '../../dot-qq-bridge/packages/dot-bridge-platform/test-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig, readTunnelReadinessConfig } from '../src/config.js';
import { createAuthenticator } from '../src/auth.js';
import { readServiceKeyDigest } from '../src/tunnel-service-auth.js';
import { createApp } from '../src/server.js';
const key = Buffer.alloc(32, 7).toString('base64url');
function fixture(t) {
  const dir = privateMkdtempSync(path.join(os.tmpdir(), 'lark-tunnel-test-')); fixtureChmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'key'); fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  const env = { AUTH_MODE: 'tunnel-service', BRIDGE_MODE: 'tunnel', TUNNEL_SERVICE_KEY_FILE: file, TUNNEL_SERVICE_OWNER_ID: 'tunnel-owner:dot-bridge', DATABASE_PATH: path.join(dir, 'test.sqlite') };
  return { dir, file, env };
}
test('tunnel service config stays explicit loopback, unbound and read-only', t => {
  const {env}=fixture(t); assert.equal(readConfig(env).principal,'tunnel-owner:dot-bridge');
  for(const change of [{BRIDGE_MODE:'sites'},{BRIDGE_MODE:''},{HOST:'0.0.0.0'},{TUNNEL_SERVICE_OWNER_ID:'provider-user'},{LARK_TRANSPORT:'long-connection'},{LARK_OWNER_OPEN_ID:'someone'},{LARK_TENANT_KEY:'tenant'},{TUNNEL_SERVICE_READINESS_ONLY:'false'}]) assert.throws(()=>readConfig({...env,...change}));
});
test('private service file rejects symlinks, hardlinks, loose modes and nonregular files',t=>{
  const {file,dir}=fixture(t); assert.equal(readServiceKeyDigest(file).length,32);
  fixtureChmodSync(file,0o644);assert.throws(()=>readServiceKeyDigest(file));fixtureChmodSync(file,0o600);
  const link=path.join(dir,'link');fixtureSymlinkSync(file,link);assert.throws(()=>readServiceKeyDigest(link));
  fs.unlinkSync(link);fs.linkSync(file,link);assert.throws(()=>readServiceKeyDigest(file));fs.unlinkSync(link);
  fixtureChmodSync(dir,0o755);assert.throws(()=>readServiceKeyDigest(file));fixtureChmodSync(dir,0o700);
  assert.throws(()=>readServiceKeyDigest(dir));
});
test('custom service header rejects duplicates, non-loopback, bearer and claimed identities without network',async t=>{
  const {env}=fixture(t);let network=0;
  const auth=createAuthenticator(readConfig(env),async()=>{network++;throw Error('unexpected network');});
  const req={headers:{'x-dot-bridge-service-key':key},rawHeaders:['X-Dot-Bridge-Service-Key',key],socket:{remoteAddress:'127.0.0.1'}};
  assert.equal((await auth(req)).id,'tunnel-owner:dot-bridge');
  await assert.rejects(auth({...req,socket:{remoteAddress:'8.8.8.8'}}));
  await assert.rejects(auth({...req,rawHeaders:[...req.rawHeaders,'x-dot-bridge-service-key',key]}));
  await assert.rejects(auth({...req,headers:{'x-dot-bridge-service-key':'a'.repeat(43)}}));
  for(const name of ['Authorization','X-Forwarded-Authorization','X-User-Id','OAI-Authenticated-User-Id','X-Owner','Forwarded','x-openai-user-id','x-oai-owner','Cookie']) await assert.rejects(auth({...req,rawHeaders:[...req.rawHeaders,name,'spoof']}));
  await assert.rejects(auth({...req,headers:{...req.headers,'x-openai-user-id':'spoof'}}));
  assert.equal(network,0);
});
test('readiness cannot subscribe, retrieve messages, reply, drain old queue or expose nonloopback listener',async t=>{
  const {env}=fixture(t);const config={...readConfig(env),dbPath:':memory:',storageKey:Buffer.alloc(32,9).toString('base64')};let network=0;
  const app=createApp(config,{send:async()=>{network++;throw Error('unexpected network');},worker:false});t.after(()=>app.close());
  const owner={id:config.principal,validUntil:Date.now()+10000};
  assert.deepEqual((await app.bridge.rpc('tools/list',{},owner)).tools,[]);
  assert.deepEqual((await app.bridge.rpc('events/list',{},owner)).events,[]);
  for(const [method,params] of [['events/subscribe',{}],['events/unsubscribe',{}],['tools/call',{name:'get_lark_message',arguments:{message_id:'x'}}],['tools/call',{name:'reply_to_lark',arguments:{message_id:'x',text:'x'}}]]) await assert.rejects(app.bridge.rpc(method,params,owner));
  assert.equal(await app.bridge.tick(),false);await assert.rejects(app.listen(0,'0.0.0.0'));
  assert.equal(network,0);
});
test('real HTTP parser rejects mixed-case duplicate service headers', async t => {
  const { request } = await import('node:http');
  const {env}=fixture(t);const app=createApp({...readConfig(env),dbPath:':memory:',storageKey:Buffer.alloc(32,9).toString('base64')},{worker:false});t.after(()=>app.close());
  const address=await app.listen(0);
  const call=headers=>new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:address.port,path:'/mcp',method:'POST',headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end('{}');
  });
  assert.equal(await call(['Host','127.0.0.1','X-Dot-Bridge-Service-Key',key,'x-dot-bridge-service-key',key]),401);
  assert.equal(await call(['Host','127.0.0.1','X-Dot-Bridge-Service-Key',key,'X-Dot-Bridge-Owner','spoof']),401);
  // Valid service authentication reaches content-type validation.
  assert.equal(await call(['Host','127.0.0.1','X-Dot-Bridge-Service-Key',key]),415);
});

test('readiness rejects mixed configuration before attempting credential file reads', t => {
  const {env}=fixture(t);
  for (const field of ['PUBLIC_ORIGIN','OAUTH_ISSUER','OAUTH_JWKS_URL','OAUTH_AUDIENCE','OAUTH_REQUIRED_SCOPE','DEV_BEARER_TOKEN','MCP_OWNER_SUBJECT','LARK_APP_ID','LARK_APP_SECRET','LARK_CREDENTIALS_FILE','MCP_CALLBACK_ALLOWED_HOSTS']) {
    assert.throws(() => readConfig({...env,[field]:'/does-not-exist'}), /cannot mix/);
  }
});
test('service key path traversal rejects intermediate directory symlinks', t => {
  const {dir,file}=fixture(t);const alias=path.join(dir,'alias');fixtureSymlinkSync(dir,alias);
  assert.throws(()=>readServiceKeyDigest(path.join(alias,path.basename(file))));
  assert.throws(()=>readServiceKeyDigest(dir+'/../'+path.basename(dir)+'/key'));
});

test('readiness entry always uses fresh memory storage and refuses persistent store settings', t => {
  const {env}=fixture(t);const {DATABASE_PATH,STORAGE_KEY,...clean}=env;
  const first=readTunnelReadinessConfig(clean),second=readTunnelReadinessConfig(clean);
  assert.equal(first.dbPath,':memory:');assert.equal(Buffer.from(first.storageKey,'base64').length,32);
  assert.notEqual(first.storageKey,second.storageKey);
  assert.throws(()=>readTunnelReadinessConfig({...clean,DATABASE_PATH}));
  assert.throws(()=>readTunnelReadinessConfig({...clean,STORAGE_KEY:Buffer.alloc(32,9).toString('base64')}));
});

test('direct createApp rejects persistent storage before touching any database', t => {
  const {env}=fixture(t);const config=readConfig(env);
  assert.equal(fs.existsSync(config.dbPath),false);
  assert.throws(()=>createApp(config),/ephemeral empty store/);
  assert.equal(fs.existsSync(config.dbPath),false);
  assert.equal(fs.existsSync(config.dbPath+'-wal'),false);
});
