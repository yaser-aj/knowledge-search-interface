import net from "node:net";

/**
 * Node races IPv4 and IPv6 with a 250ms head start between attempts. On hosts
 * where IPv6 is routed but unreachable, that window expires before the IPv4
 * handshake lands and every fetch fails with ETIMEDOUT. Model downloads and
 * OpenRouter calls both depend on this, so widen the window once at startup.
 */
let applied = false;

export function relaxConnectionRacing(): void {
  if (applied) return;
  applied = true;
  const ms = Number(process.env.KSI_CONNECT_ATTEMPT_TIMEOUT ?? 10_000);
  net.setDefaultAutoSelectFamilyAttemptTimeout(Math.max(500, ms));
}
