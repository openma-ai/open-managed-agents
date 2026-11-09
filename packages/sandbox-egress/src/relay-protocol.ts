/** The relay's wire / delivery protocol. 3 = Basic sandbox token, binding held
 * in memory and confirmed by deliveryId. The installer replaces any relay
 * that reports another protocol (older relays read the token from disk). */
export const RELAY_PROTOCOL = 3;
