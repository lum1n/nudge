// Pi Durable's storage for a Cloudflare Durable Object, for @nudge/cloudflare (ADR 21). Its own
// entry point, so Node hosts never load it.
export { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
