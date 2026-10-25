import { createContext, useContext, useEffect, useId, useState } from "react";
import { m } from "./i18n/index.ts";

/** The parts of JSON Schema that TypeBox writes for extensions' settings. */
export type Schema = {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  patternProperties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  allOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
  /** Nudge's own hints: `rooms` is a list of room ids with `*` for every room (`roomsSetting`). */
  "x-nudge"?: string;
};

/** The assistant's rooms, for settings that pick some of them; empty until loaded. */
export const RoomsContext = createContext<readonly { id: string; name: string }[]>([]);

type Value = Record<string, unknown>;

const INPUT = "w-full rounded border border-stone-300 bg-white px-2 py-1 text-sm";
/** Names whose values are usually secrets, so they get the `${NAME}` hint. */
const SECRET = /token|password|secret|key$/i;

/** Fields for an object schema's properties; a property set to `undefined` is left out. */
export function ObjectFields({
  schema,
  value,
  onChange,
}: {
  schema: Schema;
  value: Value;
  onChange: (next: Value) => void;
}) {
  const merged = mergeAllOf(schema);
  const required = new Set(merged.required ?? []);
  return (
    <div className="flex flex-col gap-3">
      {Object.entries(merged.properties ?? {}).map(([name, property]) => (
        <Field
          key={name}
          name={name}
          schema={property}
          required={required.has(name)}
          value={value[name]}
          onChange={(next) => {
            const { [name]: _, ...rest } = value;
            onChange(next === undefined ? rest : { ...rest, [name]: next });
          }}
        />
      ))}
    </div>
  );
}

function Field({
  name,
  schema,
  required,
  value,
  onChange,
}: {
  name: string;
  schema: Schema;
  required: boolean;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const id = useId();
  const label = schema.title ?? humanize(name);
  const choices = choicesOf(schema);
  const type = typeOf(schema);

  if (type === "boolean")
    return (
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium">
          <input
            id={id}
            type="checkbox"
            checked={(value ?? schema.default ?? false) as boolean}
            onChange={(event) => onChange(event.target.checked)}
            className="size-4"
          />
          {label}
        </label>
        <Help schema={schema} />
      </div>
    );

  let control;
  if (choices !== undefined)
    control = (
      <select
        id={id}
        value={value === undefined ? "" : String(choices.indexOf(value))}
        onChange={(event) =>
          onChange(event.target.value === "" ? undefined : choices[Number(event.target.value)])
        }
        className={INPUT}
      >
        {(value === undefined || !required || schema.default !== undefined) && (
          <option value="">
            {schema.default === undefined ? "—" : m.settings.form.default(String(schema.default))}
          </option>
        )}
        {choices.map((choice, index) => (
          <option key={String(choice)} value={index}>
            {String(choice)}
          </option>
        ))}
      </select>
    );
  else if (type === "number" || type === "integer")
    control = (
      <NumberInput
        id={id}
        value={value as number | undefined}
        schema={schema}
        integer={type === "integer"}
        onChange={onChange}
      />
    );
  else if (type === "string")
    control = (
      <input
        id={id}
        value={(value as string | undefined) ?? ""}
        placeholder={schema.default === undefined ? undefined : String(schema.default)}
        onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
        autoComplete="off"
        spellCheck={false}
        className={`${INPUT} font-mono`}
      />
    );
  else if (schema["x-nudge"] === "rooms")
    control = <RoomsInput value={value as string[] | undefined} onChange={onChange} />;
  else if (type === "array" && typeOf(schema.items ?? {}) === "string")
    control = (
      <LinesInput
        id={id}
        value={value as string[] | undefined}
        schema={schema}
        onChange={onChange}
      />
    );
  else if (type === "array" && typeOf(schema.items ?? {}) === "object")
    control = (
      <ObjectList
        items={(value as Value[] | undefined) ?? []}
        schema={schema.items!}
        label={label}
        onChange={(next) => onChange(next.length === 0 && !required ? undefined : next)}
      />
    );
  else if (type === "object" && mergeAllOf(schema).properties !== undefined)
    control = (
      <div className="rounded border border-stone-200 bg-stone-50 p-3">
        <ObjectFields
          schema={schema}
          value={(value as Value | undefined) ?? {}}
          onChange={(next) => onChange(Object.keys(next).length === 0 ? undefined : next)}
        />
      </div>
    );
  else if (type === "object" && recordOf(schema) !== undefined)
    control = (
      <RecordInput
        value={(value as Value | undefined) ?? {}}
        schema={recordOf(schema)!}
        label={label}
        onChange={(next) =>
          onChange(Object.keys(next).length === 0 && !required ? undefined : next)
        }
      />
    );
  else control = <JsonInput id={id} value={value} onChange={onChange} />;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required && schema.default === undefined && <span className="text-red-700"> *</span>}
      </label>
      {control}
      <Help schema={schema} secret={type === "string" && SECRET.test(name)} />
    </div>
  );
}

function Help({ schema, secret = false }: { schema: Schema; secret?: boolean }) {
  const range =
    schema.minimum !== undefined || schema.maximum !== undefined
      ? [
          schema.minimum !== undefined ? m.settings.form.atLeast(schema.minimum) : undefined,
          schema.maximum !== undefined ? m.settings.form.atMost(schema.maximum) : undefined,
        ]
          .filter(Boolean)
          .join(", ")
      : undefined;
  if (schema.description === undefined && range === undefined && !secret) return null;
  return (
    <p className="text-xs text-stone-500">
      {schema.description}
      {range !== undefined && <> ({range})</>}
      {secret && (
        <>
          {" "}
          {m.settings.form.secretBefore}{" "}
          <code className="rounded bg-stone-200 px-1">{"${NAME}"}</code>{" "}
          {m.settings.form.secretAfter}
        </>
      )}
    </p>
  );
}

function NumberInput({
  id,
  value,
  schema,
  integer,
  onChange,
}: {
  id: string;
  value: number | undefined;
  schema: Schema;
  integer: boolean;
  onChange: (next: number | undefined) => void;
}) {
  // Text while typing, so "1." or "-" can be on the way to a number.
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => {
    if (value === undefined ? text !== "" : Number(text) !== value)
      setText(value === undefined ? "" : String(value));
  }, [value]);
  return (
    <input
      id={id}
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      step={integer ? 1 : "any"}
      min={schema.minimum}
      max={schema.maximum}
      value={text}
      placeholder={schema.default === undefined ? undefined : String(schema.default)}
      onChange={(event) => {
        setText(event.target.value);
        const parsed = Number(event.target.value);
        if (event.target.value === "") onChange(undefined);
        else if (Number.isFinite(parsed)) onChange(parsed);
      }}
      className={`${INPUT} max-w-40`}
    />
  );
}

/** A list of strings, one per line. */
/** Rooms by name, with every room as one choice; ids it no longer knows are kept, by id. */
function RoomsInput({
  value,
  onChange,
}: {
  value: string[] | undefined;
  onChange: (next: string[] | undefined) => void;
}) {
  const rooms = useContext(RoomsContext);
  const chosen = value ?? [];
  const every = chosen.includes("*");
  const toggle = (id: string, on: boolean) => {
    const next = on
      ? [...chosen.filter((item) => item !== id), id]
      : chosen.filter((item) => item !== id);
    onChange(next.length === 0 ? undefined : next);
  };
  const unknown = chosen.filter((id) => id !== "*" && !rooms.some((room) => room.id === id));
  return (
    <div className="flex flex-col gap-1 rounded border border-stone-200 bg-white p-2">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4"
          checked={every}
          onChange={(event) => onChange(event.target.checked ? ["*"] : undefined)}
        />
        {m.settings.form.everyRoom}
      </label>
      {!every &&
        [
          ...rooms.map((room) => ({ id: room.id, name: room.name })),
          ...unknown.map((id) => ({ id, name: id })),
        ].map((room) => (
          <label key={room.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={chosen.includes(room.id)}
              onChange={(event) => toggle(room.id, event.target.checked)}
            />
            {room.name}
          </label>
        ))}
    </div>
  );
}

function LinesInput({
  id,
  value,
  schema,
  onChange,
}: {
  id: string;
  value: string[] | undefined;
  schema: Schema;
  onChange: (next: string[] | undefined) => void;
}) {
  const [text, setText] = useState((value ?? []).join("\n"));
  useEffect(() => {
    if (lines(text).join("\n") !== (value ?? []).join("\n")) setText((value ?? []).join("\n"));
  }, [value]);
  const defaults = Array.isArray(schema.default) ? (schema.default as string[]) : [];
  return (
    <textarea
      id={id}
      rows={Math.min(8, Math.max(2, (value?.length ?? 0) + 1))}
      value={text}
      placeholder={defaults.length > 0 ? defaults.join("\n") : m.settings.form.onePerLine}
      onChange={(event) => {
        setText(event.target.value);
        const next = lines(event.target.value);
        onChange(next.length === 0 ? undefined : next);
      }}
      className={`${INPUT} font-mono`}
    />
  );
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Repeated sub-forms, such as mail accounts. */
function ObjectList({
  items,
  schema,
  label,
  onChange,
}: {
  items: Value[];
  schema: Schema;
  label: string;
  onChange: (next: Value[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, index) => (
        <div
          key={index}
          className="flex flex-col gap-2 rounded border border-stone-200 bg-stone-50 p-3"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium tracking-wide text-stone-500 uppercase">
              {label.replace(/s$/, "")} {index + 1}
            </span>
            <button
              type="button"
              onClick={() => onChange(items.filter((_, other) => other !== index))}
              className="text-sm text-red-700 underline"
            >
              {m.common.remove}
            </button>
          </div>
          <ObjectFields
            schema={schema}
            value={item}
            onChange={(next) => onChange(items.map((other, at) => (at === index ? next : other)))}
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...items, {}])}
        className="self-start rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
      >
        {m.settings.form.add}
      </button>
    </div>
  );
}

/** A map by name, such as MCP servers: a name each, then the entry's own fields. */
function RecordInput({
  value,
  schema,
  label,
  onChange,
}: {
  value: Value;
  schema: Schema;
  label: string;
  onChange: (next: Value) => void;
}) {
  const [name, setName] = useState("");
  const entries = Object.entries(value);
  const add = () => {
    const key = name.trim();
    if (key === "" || key in value) return;
    onChange({ ...value, [key]: typeOf(schema) === "object" ? {} : "" });
    setName("");
  };
  return (
    <div className="flex flex-col gap-2">
      {entries.map(([key, item]) => (
        <div
          key={key}
          className="flex flex-col gap-2 rounded border border-stone-200 bg-stone-50 p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-sm font-medium">{key}</span>
            <button
              type="button"
              onClick={() => {
                const { [key]: _, ...rest } = value;
                onChange(rest);
              }}
              className="text-sm text-red-700 underline"
            >
              {m.common.remove}
            </button>
          </div>
          {typeOf(schema) === "object" && schema.properties !== undefined ? (
            <ObjectFields
              schema={schema}
              value={(item as Value | undefined) ?? {}}
              onChange={(next) => onChange({ ...value, [key]: next })}
            />
          ) : typeOf(schema) === "string" ? (
            <input
              value={String(item ?? "")}
              onChange={(event) => onChange({ ...value, [key]: event.target.value })}
              autoComplete="off"
              spellCheck={false}
              className={`${INPUT} font-mono`}
            />
          ) : (
            <JsonInput value={item} onChange={(next) => onChange({ ...value, [key]: next })} />
          )}
        </div>
      ))}
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder={m.settings.form.newName(label)}
          autoComplete="off"
          className={`${INPUT} min-w-0 flex-1 font-mono`}
        />
        <button
          type="button"
          onClick={add}
          disabled={name.trim() === "" || name.trim() in value}
          className="shrink-0 rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100 disabled:opacity-50"
        >
          {m.settings.form.add}
        </button>
      </div>
    </div>
  );
}

/** Anything the fields above don't cover, as JSON; kept as text until it parses. */
function JsonInput({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const [text, setText] = useState(value === undefined ? "" : JSON.stringify(value, null, 2));
  const [error, setError] = useState<string>();
  return (
    <>
      <textarea
        id={id}
        rows={Math.min(12, Math.max(3, text.split("\n").length))}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (event.target.value.trim() === "") {
            setError(undefined);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(event.target.value));
            setError(undefined);
          } catch {
            setError(m.settings.form.notJson);
          }
        }}
        spellCheck={false}
        className={`${INPUT} font-mono text-xs`}
      />
      {error !== undefined && <p className="text-xs text-amber-700">{error}</p>}
    </>
  );
}

function mergeAllOf(schema: Schema): Schema {
  if (schema.allOf === undefined) return schema;
  return schema.allOf.map(mergeAllOf).reduce<Schema>(
    (merged, part) => ({
      ...merged,
      properties: { ...merged.properties, ...part.properties },
      required: [...new Set([...(merged.required ?? []), ...(part.required ?? [])])],
    }),
    { ...schema, allOf: undefined },
  );
}

function typeOf(schema: Schema): string | undefined {
  if (schema.type !== undefined) return schema.type;
  if (schema.allOf !== undefined) return "object";
  const types = new Set((schema.anyOf ?? []).map((part) => part.type));
  return types.size === 1 ? [...types][0] : undefined;
}

/** The values a field may take, when it is one of a fixed few. */
function choicesOf(schema: Schema): unknown[] | undefined {
  if (schema.enum !== undefined) return schema.enum;
  if (schema.anyOf?.every((part) => part.const !== undefined))
    return schema.anyOf.map((part) => part.const);
  return undefined;
}

function recordOf(schema: Schema): Schema | undefined {
  const values = Object.values(schema.patternProperties ?? {});
  return values.length === 1 ? values[0] : undefined;
}

/** `pollSeconds` → "Poll seconds". */
function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** `settings` without the top-level values that equal their defaults, to keep nudge.json short. */
export function withoutDefaults(settings: Value, schema: Schema | undefined): Value {
  const properties = schema === undefined ? {} : (mergeAllOf(schema).properties ?? {});
  return Object.fromEntries(
    Object.entries(settings).filter(
      ([key, item]) =>
        properties[key]?.default === undefined ||
        JSON.stringify(properties[key]!.default) !== JSON.stringify(item),
    ),
  );
}
