// Vitest's module runner can't load undici's CommonJS in workerd (wrangler's bundle can). Only
// Wired, which a Worker never starts, uses it.
export class Dispatcher {}
export class Agent extends Dispatcher {}
export function setGlobalDispatcher(): void {}
