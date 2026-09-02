/**
 * The channels a seeded demo lead may arrive on, and the provider that carries each one.
 *
 * "Where they came from" on the coach's contacts table reads `contact_identities`, not
 * `contacts.last_channel`. A seeded lead stamped `webchat` therefore rendered "no channel saved":
 * the demo tenant has no web-chat `channel_connections` row, `channel_provider` has only
 * `meta_direct` and `ghl` in it, and no code path in the product mints a web-chat identity. The
 * seed was claiming an arrival the product cannot produce, and the honest cell said so.
 *
 * So the seeders cycle these four instead, and every seeded contact carries the identity that
 * proves its channel. The provider on each row is the one the demo tenant's own
 * `channel_connections` hold, so a lead's channel, its identity and its connection all agree.
 *
 * Adding `webchat` back here is not the way to demo web chat. That needs a connection, a provider
 * and an identity path first, and until those exist a seeded web-chat lead is a fiction.
 */
export const DEMO_CONNECTED_CHANNELS = Object.freeze([
  Object.freeze({ channel: "instagram", provider: "meta_direct" }),
  Object.freeze({ channel: "messenger", provider: "meta_direct" }),
  Object.freeze({ channel: "sms", provider: "ghl" }),
  Object.freeze({ channel: "whatsapp", provider: "meta_direct" }),
]);

/** Channel names alone, for the seeders that only stamp `contacts.last_channel`. */
export const DEMO_CONNECTED_CHANNEL_NAMES = Object.freeze(
  DEMO_CONNECTED_CHANNELS.map((entry) => entry.channel),
);

export function demoChannelFor(index) {
  return DEMO_CONNECTED_CHANNELS[index % DEMO_CONNECTED_CHANNELS.length];
}
