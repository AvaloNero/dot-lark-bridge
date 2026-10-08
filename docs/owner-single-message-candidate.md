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
