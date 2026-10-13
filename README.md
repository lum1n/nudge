# Nudge

An extendable, multiplayer personal assistant that keeps personal data away from model providers. Lightweight, self-hostable, and embeddable as a library. Built on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable).

> Early work in progress. Pi Durable is experimental and changes without notice, so Nudge pins exact versions.

## Packages

- `@nudge/core`: the embeddable library. One `Nudge` is one assistant: one storage, one Harness, one registry.

## Develop

Requires Node ≥ 22.19 and pnpm.

```bash
pnpm install
pnpm check   # typecheck, lint, test
```
