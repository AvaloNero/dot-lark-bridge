# Isolated owner single-message candidate

This is offline engineering for one Feishu owner test, not activation of the
ordinary live bridge. `node scripts/owner-message-candidate.js` is plan-only;
only the exact `--confirm-owner-single-message-experiment` flag selects the separate
review runtime. No real invocation was made during this implementation.

`src/single-message-candidate.js` verifies SDK event provenance plus the fixed
application, tenant, owner and private chat. The current candidate accepts any ordinary text from that verified owner; the
first accepted message consumes the single incoming budget. Message text is data,
not an instruction or authorization. Exact-text mode remains only for compatible
offline fixtures. It provides one callback event claim
and one preselected reply claim. Expiry, cancellation, ambiguous acknowledgement
and failures never reset budgets or cause resend. No IDs, text or credentials
are included in its status projection.

`src/owner-message-session.js` composes the candidate with an explicitly injected
shared owner-message experimental transport, authenticated local owner principal,
signed callback challenge and the existing fixed-message Feishu reply sender.
It is intentionally not imported by ordinary services. The session itself starts no WebSocket, HTTP listener or credential reader.
`src/owner-message-runtime.js` wraps it in a bounded loopback MCP listener using
the existing authentication and MCP validation; only a verified subscription
starts a non-reconnecting gateway. It takes the same application/mode lock. The
launcher with the additional explicit `--wait-for-owner` flag waits for the owner without a process-wide fifteen-minute
cutoff; it closes on reply completion, unrecoverable failure or cancellation.
A subscription expiry pauses the gateway while retaining the local MCP listener
for renewal. Renewal requires the same authenticated owner, exact callback URL
and secret, and never resets the one-message budget. Once a message is accepted,
its original reply deadline and subscription expiry remain binding. Integration remains
subject to shared experimental scope recognition; production callback readiness
is never asserted. The forced proxy's final destination IP remains unverified.

Before any real run, the approved paired credential reference must exist and be
validated without exposing its contents. An unbound enrollment needs official
owner/tenant verification and pairing; never infer identity from the first sender.
If no enrollment exists, prepare the existing-app official scan only after its
specific access and private-save authorization. Do not ask for secrets in chat.
The actual run also needs an approved fixed reply, bounded window, a single
authenticated callback and explicit acceptance of the proxy experiment's remaining
final-IP uncertainty. Sharing this candidate grants none of those permissions.


The confirmed launcher requires `LARK_CREDENTIALS_FILE` (already paired),
`LARK_EXPECTED_APP_ID`, `TUNNEL_SERVICE_KEY_FILE`, `BRIDGE_LOCK_DIRECTORY`,
`OWNER_MESSAGE_FIXED_REPLY` and optional
`OWNER_MESSAGE_PORT` (default 3102). It statically imports the experimental shared owner-message export from
`../dot-qq-bridge/packages/dot-bridge-transport/experimental/owner-message.js`
and the catalog from that sibling repository. Clone both repositories side by
side; no third review-workspace tree is required. This remains an explicitly
scoped experiment, not ordinary production callback readiness.
It does not accept an environment-selected module or adapter path. Callback
hostname discovery is allowed only after the fixed local principal is
successfully authenticated; the shared experiment then locks the complete URL.
The ordinary bridge's allowlist and production preflight remain unchanged.

Full offline shared integration uses `OWNER_MESSAGE_TRANSPORT_SOURCE` only in
the test harness to name the reviewed factory file. That variable is never read
by a runtime. The tests inject a fake CONNECT operation and fake provider replies;
passing does not demonstrate real TLS/provider delivery or final proxy IP binding.

The candidate launcher selects the reviewed shared factory with the code-only
`acceptAnyOwnerText:true` option. No prescribed user phrase or extra authorization
word is required. The event and read tool contain the accepted message text, not
a configured placeholder. Owner, application, tenant, chat, freshness, callback
URL and one-message/one-reply boundaries remain enforced.

## Existing-app enrollment and owner binding

With explicit approval for the existing application's official scan and private
credential storage, the file-handoff helper uses the same SDK registration flow:

```sh
node scripts/enroll-existing-file-handoff.js APP_ID --tenant-pending /private/lark/unbound.json /private/lark/new-enrollment-attempt --confirm-existing-app-scan --confirm-private-storage
```

These file-handoff helpers currently target the Linux cloud computer; Windows
application credential storage support does not imply Windows support for this
POSIX report collector. The attempt directory must be new. It contains private `handoff.json` and a
redacted `status.json`, including heartbeat, request/response timestamps and
fixed transport error classes. Share the exact official link only with the
operator. A heartbeat, exit hook or saved status alone does not prove a live
process; the supervising executor must establish completion separately.

The official scan's owner identity can then be matched against one new private
message from that exact owner over the authenticated application connection:

```sh
node scripts/pair-scanned-owner-file-handoff.js APP_ID /private/lark/unbound.json /private/lark/paired.json /private/lark/new-pairing-attempt /private/locks --confirm-scanned-owner-test-message
```

Despite the historical flag name, any ordinary text is accepted. The listener
checks application, exact scanned owner, private chat, matching sender/header
tenant and freshness. It starts its five-minute window only when the connection
is ready, persists routing identity only, and sends no reply or MCP event.
The bounded message experiment is a separate explicit invocation after pairing.

Source reproduction requires the complete sibling QQ checkout, including
`packages/dot-bridge-platform` and `packages/dot-bridge-tunnel`, not only the
transport package. The existing Docker recipe copies transport alone and is
not a supported packaging route for this candidate; no container deployment
is included or verified in this change.

The new waiting behavior is prepared offline and is not permission to start or
extend a real service. Protocol leases remain finite; the task client must renew
them. An expired lease authorizes no incoming message, callback or reply. The
legacy code-injected finite-deadline mode remains available for bounded tests.

A supervisor can explicitly preserve the previous timed run by calling
`startOwnerMessageCandidate({ approved: true, waitForOwner: false })`.
That branch reads `OWNER_MESSAGE_WINDOW_SECONDS` (30–900, default 300) and passes
the same absolute deadline through the gate, transport, provider and runtime.
The explicit `waitForOwner: true` branch does not read that variable. Both values
must be literal booleans; strings and numeric aliases are rejected before reads.

The public API and confirmed CLI default to the previous timed mode. Only an
explicit `waitForOwner: true` API option or additional `--wait-for-owner` CLI
flag enables waiting. A no-argument CLI remains plan-only; its
`supports_wait_for_owner: true` capability does not imply activation.

For a delivered event whose wake did not expose the event payload to the caller,
the existing authenticated `check_lark_setup` returns optional `pending_message`
metadata in the isolated experiment: only `message_id` and `reply_deadline`, or
null. It never returns the text, source identity, callback URL or credentials.
Only the single successfully delivered, still-valid message before reply claim
is eligible. This read does not extend its deadline or consume a reply budget.
The aggregate exposes the same metadata through `check_lark_readiness`; ordinary
bridge readiness and the public tool names remain unchanged. Metadata lives in
the existing process only and does not recover a terminated process's memory.


## Callback scope evidence

Before a lease exists, the waiting experiment reports `awaiting_subscription`,
with `ready: false`, `destination_binding: unverified` and
`network_checked: false`. Expiry and closure have separate `scope_expired` and
`scope_closed` reasons. Ordinary managed-proxy policy failures remain
`proxy_policy_unverified`; these lifecycle labels do not verify network safety.

The existing service-key authentication identifies the fixed local owner.
Before any callback connection, the session validates the subscription's exact
HTTPS URL, signing-secret format and finite authenticated lease. The sender
then binds that full URL and subscription ID before CONNECT; renewal requires
the same URL and secret. This proves consistency with the authenticated
subscription. It does not independently attest that an initially supplied URL
belongs to a particular dot or platform: any authorized holder of this personal
Tunnel/service key can choose that initial destination. The proxy's final
resolved IP remains unverified. No change to these labels expands authority.

## Durable subscription recovery

Operational launch requires stable private `OWNER_MESSAGE_DATABASE_PATH` and
`STORAGE_KEY_FILE` references, outside the source tree and run-generation
folders. The independent local storage key must differ from the service
credential. The launcher acquires the existing application lock before opening
the existing SQLite Store; its Vault encrypts the complete candidate checkpoint
inside the metadata table, with synchronous transactions. This is payload
encryption, not encryption of all database metadata. Directory/file checks and
storage key loading reuse the existing private-storage guards.

After callback verification, the original subscription identity, URL, signing
secret and finite granted expiry are committed before the subscribe response.
Renewal of the same identity updates that checkpoint before acknowledging it.
The safe lifecycle status reports only `subscription_expires_at` and
`subscription_persisted`, so the granted expiry need not be guessed from message
reply deadlines. Resource shutdown preserves the grant; authenticated
unsubscribe durably cancels it. The operator must stop the platform task when
revoking ongoing monitoring rather than treating a server restart as revocation.

An unexpired waiting grant restores the gateway without another subscribe or
challenge. Expired grants require authenticated renewal. Event and reply attempts
are saved before their network operation. Attempts interrupted by a restart
become terminal uncertain and are never retried. Successful delivery restores
only message ID, source event ID, event ID, timestamps and the original deadline:
message text is never persisted. The read tool therefore returns `text: null`
after restart, while the fixed reply may still be sent once within the original
lease and message deadline. No lost historical message or old unrecorded grant
can be reconstructed. A completed or uncertain scope does not receive a new
single-message budget by restarting it or choosing another generation directory.

This isolated single-message protocol deliberately refuses a different callback
URL or signing secret on renewal; automatic signing-secret rotation is not
implemented here. It never silently substitutes a destination or widens access.

## Reply acknowledgement and shutdown

The authenticated `reply_to_lark` response has a 30-second socket budget,
matching its aggregate upstream call. Ordinary reads retain their existing
budgets. The provider may need two sequential requests (token and reply), each
with its existing 10-second bound; message expiry, authorization and abort
checks still apply. There are no automatic retries when acknowledgement is
unknown. A local upstream timeout is a transport failure, not evidence that the
provider did not send; an outer client's error-code mapping must be verified
separately.

After a terminal reply, shutdown waits for the HTTP response's `finish` or
connection `close` event. It introduces no additional sleep period or persistent
business listener. If the caller disconnected while the approved reply was in
flight, completion still closes the scope. The encrypted checkpoint and existing
supervisor's redacted terminal status are retained for read-only reconciliation;
operators must not resend merely because the upstream response was lost.
