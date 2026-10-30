import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/**
 * A card a tool shows in the transcript: blocks to read, fields to fill and buttons to press,
 * drawn by each app with its own controls, so nothing in it runs (ADR 27). A tool gives it as
 * `details.ui`; a press comes back to the room as a message from whoever pressed it.
 *
 * Only TypeBox here: `@nudge/protocol` re-exports these schemas for clients.
 */

/**
 * Most characters a card takes as JSON. A view leaves out a tool's details over 8 KiB, card and
 * all, so this leaves room for what else they hold.
 */
export const UI_CARD_MAX_CHARS = 7 * 1024;

const Short = (maxLength: number) => Type.String({ maxLength });

export const UiBlock = Type.Union([
  Type.Object({ type: Type.Literal("heading"), text: Short(200) }),
  /** Markdown, as messages have it. */
  Type.Object({ type: Type.Literal("text"), markdown: Short(4000) }),
  Type.Object({
    type: Type.Literal("kv"),
    pairs: Type.Array(Type.Object({ label: Short(100), value: Short(500) }), { maxItems: 20 }),
  }),
  Type.Object({
    type: Type.Literal("list"),
    items: Type.Array(Type.Object({ title: Short(200), subtitle: Type.Optional(Short(500)) }), {
      maxItems: 30,
    }),
  }),
  Type.Object({
    type: Type.Literal("table"),
    columns: Type.Array(Short(100), { minItems: 1, maxItems: 8 }),
    rows: Type.Array(Type.Array(Short(300), { maxItems: 8 }), { maxItems: 50 }),
  }),
  /** One of the room's attachments, by id; never an address, so a card can't make apps fetch one. */
  Type.Object({
    type: Type.Literal("image"),
    attachment: Type.String({ pattern: "^a[0-9]+$" }),
    alt: Short(300),
  }),
  Type.Object({ type: Type.Literal("divider") }),
]);
export type UiBlock = Static<typeof UiBlock>;

/** A value the card asks for. What people fill in goes to the model, so it is never a secret. */
export const UiField = Type.Object({
  /** What the answer names it: a letter, then letters, digits and `_`. */
  name: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,39}$" }),
  label: Short(100),
  type: Type.Union([
    Type.Literal("text"),
    Type.Literal("number"),
    Type.Literal("boolean"),
    Type.Literal("choice"),
  ]),
  /** A `choice`'s options. */
  options: Type.Optional(Type.Array(Short(100), { minItems: 1, maxItems: 20 })),
  placeholder: Type.Optional(Short(200)),
  /** A `text` field of several lines. */
  multiline: Type.Optional(Type.Boolean()),
  /** It may be left empty; required otherwise. */
  optional: Type.Optional(Type.Boolean()),
});
export type UiField = Static<typeof UiField>;

export const UiButton = Type.Object({
  /** What the answer names it: letters, digits, `_` and `-`. */
  id: Type.String({ pattern: "^[A-Za-z0-9_-]{1,40}$" }),
  label: Short(60),
  style: Type.Optional(Type.Union([Type.Literal("primary"), Type.Literal("danger")])),
  /** Pressing it sends no field values and needs none filled in, as for "Cancel". */
  skipsFields: Type.Optional(Type.Boolean()),
});
export type UiButton = Static<typeof UiButton>;

/** What a card holds besides its version, as the `show_ui` tool takes it. */
const content = {
  title: Type.Optional(Short(200)),
  blocks: Type.Optional(Type.Array(UiBlock, { maxItems: 30 })),
  fields: Type.Optional(Type.Array(UiField, { maxItems: 10 })),
  buttons: Type.Optional(Type.Array(UiButton, { maxItems: 6 })),
  /** Its buttons work once, for anyone; true when absent. */
  once: Type.Optional(Type.Boolean()),
  /** Who may press: anyone in the room, or only who the answer was for. `room` when absent. */
  who: Type.Optional(Type.Union([Type.Literal("room"), Type.Literal("asker")])),
};
export const UiCardContent = Type.Object(content);
export type UiCardContent = Static<typeof UiCardContent>;

export const UiCard = Type.Object({ v: Type.Literal(1), ...content });
export type UiCard = Static<typeof UiCard>;

/** The values a press sends, by field name. */
export type UiValues = Readonly<Record<string, string | number | boolean>>;

/** The card in a tool's details, when there is a valid one. */
export function cardOf(details: unknown): UiCard | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const ui = (details as { ui?: unknown }).ui;
  return ui !== undefined && Value.Check(UiCard, ui) ? ui : undefined;
}

/** Why a card can't be shown, or undefined when it can. */
export function cardProblem(card: unknown): string | undefined {
  if (Value.Check(UiCard, card)) {
    const names = new Set<string>();
    for (const field of card.fields ?? []) {
      if (names.has(field.name)) return `Field "${field.name}" is there twice`;
      names.add(field.name);
      if (field.type === "choice" && (field.options?.length ?? 0) === 0)
        return `Field "${field.name}" is a choice without options`;
    }
    const ids = new Set<string>();
    for (const button of card.buttons ?? []) {
      if (ids.has(button.id)) return `Button "${button.id}" is there twice`;
      ids.add(button.id);
    }
    if ((card.blocks?.length ?? 0) === 0 && card.title === undefined)
      return "A card needs a title or a block";
    return undefined;
  }
  const error = Value.Errors(UiCard, card)[0];
  return error === undefined
    ? "Not a card"
    : `${error.instancePath === "" ? "card" : error.instancePath}: ${error.message}`;
}

/** A press the card doesn't allow: an unknown button, or values its fields don't take. */
export class UiPressInvalid extends Error {
  override name = "UiPressInvalid";
}

/**
 * What the room gets when someone presses `buttonId` with `values`: the text of their message,
 * naming the button and each field it sends. Throws `UiPressInvalid` when the card doesn't allow it.
 */
export function pressText(card: UiCard, buttonId: string, values: UiValues = {}): string {
  const button = card.buttons?.find((found) => found.id === buttonId);
  if (button === undefined) throw new UiPressInvalid(`No button "${buttonId}"`);
  const on = card.title === undefined ? "" : ` on "${card.title}"`;
  const lines = [`Pressed "${button.label}"${on}`];
  if (button.skipsFields === true) return lines[0]!;
  const fields = card.fields ?? [];
  for (const name of Object.keys(values))
    if (!fields.some((field) => field.name === name))
      throw new UiPressInvalid(`No field "${name}"`);
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined || value === "") {
      if (field.optional !== true) throw new UiPressInvalid(`"${field.label}" is required`);
      continue;
    }
    lines.push(`${field.label}: ${shown(field, value)}`);
  }
  return lines.join("\n");
}

function shown(field: UiField, value: string | number | boolean): string {
  switch (field.type) {
    case "boolean":
      if (typeof value !== "boolean") throw new UiPressInvalid(`"${field.label}" is yes or no`);
      return value ? "yes" : "no";
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new UiPressInvalid(`"${field.label}" is a number`);
      return String(value);
    case "choice":
      if (typeof value !== "string" || !(field.options ?? []).includes(value))
        throw new UiPressInvalid(`"${field.label}" is one of its options`);
      return value;
    case "text":
      if (typeof value !== "string") throw new UiPressInvalid(`"${field.label}" is text`);
      if (value.length > 2000) throw new UiPressInvalid(`"${field.label}" is too long`);
      return field.multiline === true ? `\n${value}` : value;
  }
}
