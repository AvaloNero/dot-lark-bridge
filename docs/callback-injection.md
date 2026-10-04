# Callback sender injection

Both bridges use the same code-only injection names:

- `makePublicRequester({ managedAdapter })` takes a reviewed adapter object with exactly one own data property, `send(target, request)`.
- `makePublicRequester({ callbackTransport })` takes a callback transport function. Its optional `preflight()` is projected into the closed callback status schema; absent or malformed status stays unverified.
- `managedCallbackAdapter` and `callbackSend` are compatibility aliases. Conflicting aliases, simultaneous adapter and transport overrides, unknown option names, and malformed objects throw fixed errors before request construction. Repeating the identical object under both alias names is accepted.

These are dependency injection interfaces in this project. They do not identify an official installed proxy component. No supported real managed callback adapter is supplied here. A synthetic adapter's response, an injected status, or `ready: true` is not evidence of working network transport. Managed status retains `destination_binding: delegated_unverified` and `network_checked: false`.

The launcher calls `createServiceSender({ proxyEnv, requesterFactory })` once. Its default is `makePublicRequester`; a future reviewed launcher can provide a statically imported code factory that calls `makePublicRequester({ ...options, managedAdapter })`. The factory receives `{ proxyEnv }` and returns the sender function. No environment flag, module path, arbitrary import, credential, or permission switch selects a factory. Existing proxy configuration with no adapter remains blocked before DNS or network access. The existing direct pinned path remains available in environments without a proxy.

Pass the returned `send` to the service and its preflight. The service forwards that exact function into the app and the selected Sites runtime. Callback challenge and queued event dispatch both use the app's sender. Provider request routing and provider/callback budgets retain their existing defaults.

All plan and unconfirmed branches return before sender or credential construction. Configuration checks are local configuration inspection, and can read approved credential file references when they validate configuration; they never establish network readiness.

Lark formal wiring lives in `scripts/run-service.js` and `scripts/run-tunnel-live.js`: both create one sender and pass it to `createPersistentService(config, { send, ...options })`. `service.preflight()` and lifecycle status read the same sender, and the service forwards it into the selected app. `src/main.js` uses the persistent service entrypoint. The live entrypoint prints its offline plan without constructing configuration or a sender when unconfirmed; the persistent entrypoint refuses unconfirmed execution.

Offline verification: `node --test --test-concurrency=1 test/requester-injection.test.js test/network-auth.test.js test/callback-production.test.js`. The service-specific test `formal sender factory is constructed once and shared by preflight and both runtime modes` uses inert lifecycle doubles. These checks use synthetic values and do not verify a deployed callback or connect to a provider.
