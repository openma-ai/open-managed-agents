/** The relay's wire / delivery protocol. 4 = fixed loopback port; Basic sandbox token, binding held
 * in memory and confirmed by deliveryId. The installer replaces any relay
 * that reports another protocol (older relays read the token from disk). */
export const RELAY_PROTOCOL = 4;
