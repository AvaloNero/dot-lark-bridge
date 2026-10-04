// Compatibility entrypoint: all actual service work, including draining an
// existing outbound queue with the gateway disabled, must use the same explicit
// mode/production/lock gate. Offline fixtures use scripts/simulate.js instead.
import '../scripts/run-service.js';
