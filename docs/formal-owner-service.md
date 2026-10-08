# Continuous owner-only Feishu service

The formal service reuses `Bridge`, `Store`, the existing worker and official
SDK connection. It is separate from the single-message experimental launcher.
It accepts successive plain-text messages from the exact paired app, owner,
tenant and private chat, and queues one freely composed plain-text answer for
each verified message ID. The server derives the recipient from the stored
message; message text is data and cannot grant access or authorize other tools.

## Explicit configuration

Use the paired credential, independent service key and storage key file
references already supported by the live entrypoint. Select a new private formal
SQLite database, separate from the single-message checkpoint database. Keep both
source repositories side by side.

```
AUTH_MODE=tunnel-service
BRIDGE_MODE=tunnel
TUNNEL_SERVICE_OPERATION=live
CALLBACK_TRANSPORT_MODE=owner-scoped-proxy
TUNNEL_SERVICE_OWNER_ID=tunnel-owner:dot-bridge
LARK_TRANSPORT=long-connection
HOST=127.0.0.1
LARK_EXPECTED_APP_ID=YOUR_EXISTING_APP_ID
LARK_CREDENTIALS_FILE=/private/bridge/paired-credentials.json
TUNNEL_SERVICE_KEY_FILE=/private/bridge/service-key
STORAGE_KEY_FILE=/private/bridge/storage-key
DATABASE_PATH=/private/bridge/formal-messages.sqlite
BRIDGE_LOCK_DIRECTORY=/private/bridge/locks
REPLY_TTL_SECONDS=900
TEXT_RETENTION_SECONDS=86400
```

The retention value above is an example, not an authorization to store real
message bodies. Before activation, agree on ongoing owner-message access,
private encrypted message/reply storage and its retention period. Configuration
must keep retention at least as long as the reply window. The default remains
seven days when no retention setting is supplied. A plan invocation reads no
credentials and opens no connections. The confirmed entrypoint is:

```
node scripts/run-tunnel-live.js --confirm-live-owner-bridge
```

No environment-selected module or fabricated readiness flag chooses a sender.
`standard` is still the default transport mode and retains its existing proxy
policy. The explicit owner-scoped mode statically selects the reviewed shared
CONNECT/TLS implementation. Its status preserves `destination_binding:
unverified` and `network_checked: false`; final proxy-resolved IP is not attested.

## Subscription and message lifecycle

Only an authenticated fixed local owner may choose the initial HTTPS callback.
If `MCP_CALLBACK_ALLOWED_HOSTS` is nonempty it remains an exact host restriction;
otherwise this explicit mode uses the full authenticated subscription URL as
its scope. Every callback connection receives a current authorization snapshot
covering the principal, full URL, subscription ID, expiry and verification state.
Application events additionally require the current SQLite job lease and
subscription generation. This is not independent proof of platform URL ownership.

Subscriptions and signing secrets use the existing encrypted Store, including
renewal and secret rotation. Restarts retain their granted lifetime. SDK
reconnect discovery and each socket dial recheck the active subscription;
stopping the connection aborts queued discovery requests. No valid subscription
means no provider gateway business access.

Incoming SDK events are committed before acknowledgement. Message ID and source
event ID deduplicate redeliveries across restarts. Equal-due jobs use durable
insertion order. In this mode a callback attempted before an interruption becomes
`uncertain`; it is not automatically replayed. A sender that reports
`request_busy` or `capacity_exceeded` before any attempt may be locally rescheduled.
The original message deadline is never extended by retry or restart.

`reply_to_lark` queues the supplied text and immediately returns `pending`.
`get_lark_message` exposes its durable status. An identical repeated reply is
idempotent; a different reply for the same ID is rejected. Provider acknowledgement
is required for `sent`; unknown acknowledgements are never automatically resent.
The service remains available for later owner messages after one reply completes.

When event metadata is absent from a client wake, the existing authenticated
`check_lark_setup` exposes at most ten `pending_messages` entries containing only
message ID, original reply deadline and reply status. Only the current owner's
active subscription generation is eligible. The aggregate keeps the existing
`check_lark_readiness` name. Terminal or expired replies are not pending entries;
known IDs remain available through the ordinary read tool while authorized.

## Storage and interaction limits

Message and reply payloads are encrypted with the independent storage key;
identity, queue state and deduplication metadata are not whole-database encrypted.
The worker logically clears text after both its retention period and original
reply window end. Cleanup runs during service work, at most hourly. SQLite WAL,
backups and filesystem recovery are not secure erasure. Deduplication tombstones
remain so deletion of text cannot cause a duplicate send.

This first formal phase keeps normal bounded plain text and source-message
routing. Typing reactions, markdown posts, CardKit streaming and long-text
fragmentation are not enabled. They require explicit interaction and permission
choices rather than silently adding API scopes or extra outbound messages.

The database also records the callback transport mode. Reopening an owner-scoped
queue under `standard` is refused, so an interrupted scoped event cannot silently
inherit another mode's retry policy. A legacy queue containing messages or a
single-message checkpoint requires an explicit migration or a separate approved
formal database; startup never migrates these records automatically.
