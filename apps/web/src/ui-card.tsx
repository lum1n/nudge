import type { Player, UiBlock, UiButton, UiCard as Card, UiField } from "@nudge/client";
import { type ReactNode, useEffect, useState } from "react";
import { clientFor } from "./api.ts";
import { m } from "./i18n/index.ts";

export { cardIn } from "./cards.ts";

type Values = Record<string, string | number | boolean>;

/**
 * A card a tool showed in the chat: its blocks, fields and buttons, drawn with plain controls.
 * A press posts to the server, which puts it in the room as the reader's message.
 */
export function UiCardView(props: {
  assistant: string;
  room: string;
  callId: string;
  card: Card;
  pressed?: { button: string; by: Player };
  /** Draws a block of markdown as messages draw it. */
  markdown: (text: string) => ReactNode;
}) {
  const { card, pressed } = props;
  const [values, setValues] = useState<Values>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const done = pressed !== undefined && card.once !== false;
  const fields = card.fields ?? [];

  async function press(button: UiButton) {
    setError(undefined);
    const sent = button.skipsFields === true ? undefined : filled(fields, values);
    if (typeof sent === "string") return setError(m.room.chat.card.missing(sent));
    setBusy(true);
    try {
      await clientFor(props.assistant).api.pressCard(props.room, props.callId, button.id, sent);
      setValues({});
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const label = card.buttons?.find((button) => button.id === pressed?.button)?.label;
  return (
    <div className="my-1 flex flex-col gap-2 rounded border border-stone-300 bg-white px-3 py-2 text-sm">
      {card.title !== undefined && <h4 className="font-semibold">{card.title}</h4>}
      {(card.blocks ?? []).map((block, index) => (
        <Block key={index} block={block} {...props} />
      ))}
      {!done &&
        fields.map((field) => (
          <Field
            key={field.name}
            field={field}
            value={values[field.name]}
            disabled={busy}
            onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
          />
        ))}
      {(card.buttons ?? []).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {(card.buttons ?? []).map((button) => (
            <button
              key={button.id}
              type="button"
              disabled={busy || done}
              onClick={() => void press(button)}
              className={`rounded px-2 py-0.5 disabled:opacity-50 ${
                button.style === "primary"
                  ? "bg-sky-700 text-white"
                  : button.style === "danger"
                    ? "bg-red-700 text-white"
                    : "border border-stone-300"
              } ${pressed?.button === button.id ? "ring-2 ring-stone-500" : ""}`}
            >
              {button.label}
            </button>
          ))}
        </div>
      )}
      {pressed !== undefined && (
        <p className="text-stone-500">
          {m.room.chat.card.pressedBy(label ?? pressed.button, pressed.by.displayName)}
        </p>
      )}
      {error !== undefined && <p className="text-red-700">{error}</p>}
    </div>
  );
}

/** The values to send, or the label of a required field left empty. */
function filled(fields: readonly UiField[], values: Values): Values | string {
  const sent: Values = {};
  for (const field of fields) {
    const value = values[field.name] ?? (field.type === "boolean" ? false : undefined);
    if (value === undefined || value === "") {
      if (field.optional !== true) return field.label;
      continue;
    }
    sent[field.name] = value;
  }
  return sent;
}

function Field(props: {
  field: UiField;
  value: string | number | boolean | undefined;
  disabled: boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  const { field, value, disabled, onChange } = props;
  const title = (
    <span>
      {field.label}
      {field.optional === true && (
        <span className="text-stone-500">{m.room.chat.card.optional}</span>
      )}
    </span>
  );
  const input = "rounded border border-stone-300 bg-white px-2 py-1";
  if (field.type === "boolean")
    return (
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {title}
      </label>
    );
  return (
    <label className="flex flex-col gap-0.5">
      {title}
      {field.type === "choice" ? (
        <select
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={input}
        >
          <option value="">{m.room.chat.card.choose}</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : field.type === "text" && field.multiline === true ? (
        <textarea
          rows={3}
          value={typeof value === "string" ? value : ""}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={input}
        />
      ) : (
        <input
          type={field.type === "number" ? "number" : "text"}
          value={value === undefined ? "" : String(value)}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={(event) => {
            const text = event.target.value;
            onChange(field.type === "number" && text !== "" ? Number(text) : text);
          }}
          className={input}
        />
      )}
    </label>
  );
}

function Block(props: {
  block: UiBlock;
  assistant: string;
  room: string;
  markdown: (text: string) => ReactNode;
}) {
  const { block } = props;
  switch (block.type) {
    case "heading":
      return <h5 className="font-medium">{block.text}</h5>;
    case "text":
      return <div>{props.markdown(block.markdown)}</div>;
    case "kv":
      return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {block.pairs.map((pair, index) => (
            <div key={index} className="contents">
              <dt className="text-stone-500">{pair.label}</dt>
              <dd className="[overflow-wrap:anywhere]">{pair.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "list":
      return (
        <ul className="flex flex-col gap-1">
          {block.items.map((item, index) => (
            <li key={index}>
              <div>{item.title}</div>
              {item.subtitle !== undefined && (
                <div className="text-xs text-stone-500">{item.subtitle}</div>
              )}
            </li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div className="max-w-full overflow-x-auto">
          <table className="text-left">
            <thead>
              <tr>
                {block.columns.map((column, index) => (
                  <th key={index} className="border-b border-stone-300 pr-3 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index}>
                  {block.columns.map((_, cell) => (
                    <td key={cell} className="border-b border-stone-100 pr-3">
                      {row[cell] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "image":
      return <AttachmentImage {...props} id={block.attachment} alt={block.alt} />;
    case "divider":
      return <hr className="border-stone-200" />;
    default:
      // A block this app doesn't know yet.
      return null;
  }
}

function AttachmentImage(props: { assistant: string; room: string; id: string; alt: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let made: string | undefined;
    let gone = false;
    void clientFor(props.assistant)
      .api.attachment(props.room, props.id)
      .then((blob) => {
        if (gone || !blob.type.startsWith("image/")) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      gone = true;
      if (made !== undefined) URL.revokeObjectURL(made);
    };
  }, [props.assistant, props.room, props.id]);
  if (url === undefined) return <p className="text-stone-500">{props.alt}</p>;
  return <img src={url} alt={props.alt} className="max-h-80 max-w-full rounded" />;
}
