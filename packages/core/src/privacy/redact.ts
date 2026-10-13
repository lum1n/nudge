import type { AssistantMessage, Context, JsonValue, Message } from "@earendil-works/pi-ai";
import type { PiiDetector } from "./detectors.ts";
import { type Vault, withoutPartialPlaceholder } from "./vault.ts";

type Text = (text: string) => string;

/** Applies `change` to every string leaf of a JSON value. Keys stay as they are. */
export function mapStrings<T extends JsonValue | undefined>(value: T, change: Text): T {
  if (typeof value === "string") return change(value) as T;
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, change)) as unknown as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, change)]),
    ) as T;
  }
  return value;
}

/**
 * A copy of a request with personal values replaced by placeholders. Covers the system prompt and
 * its sections, user and tool-result text, assistant text and tool-call arguments. Leaves alone:
 * thinking (providers replay it signed), images, and tool declarations.
 */
export function redactContext(
  context: Context,
  vault: Vault,
  detectors: readonly PiiDetector[],
): Context {
  const redact: Text = (text) => vault.redact(text, detectors);
  return {
    ...context,
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: redact(context.systemPrompt) }),
    messages: context.messages.map((message) => redactMessage(message, redact)),
  };
}

function redactMessage(message: Message, redact: Text): Message {
  switch (message.role) {
    case "system":
      return {
        ...message,
        content:
          typeof message.content === "string"
            ? redact(message.content)
            : textBlocks(message.content, redact),
        ...(message.sections === undefined
          ? {}
          : {
              sections: Object.fromEntries(
                Object.entries(message.sections).map(([key, text]) => [
                  key,
                  text === null ? null : redact(text),
                ]),
              ),
            }),
      };
    case "user":
      return {
        ...message,
        content:
          typeof message.content === "string"
            ? redact(message.content)
            : textBlocks(message.content, redact),
      };
    case "assistant":
      return { ...message, content: assistantBlocks(message.content, redact) };
    case "toolResult":
      return {
        ...message,
        content: textBlocks(message.content, redact),
        ...(message.details === undefined ? {} : { details: mapStrings(message.details, redact) }),
      } as Message;
  }
}

function textBlocks<T extends { type: string }>(blocks: readonly T[], change: Text): T[] {
  return blocks.map((block) =>
    block.type === "text"
      ? { ...block, text: change((block as unknown as { text: string }).text) }
      : block,
  );
}

function assistantBlocks(
  blocks: AssistantMessage["content"],
  change: Text,
): AssistantMessage["content"] {
  return blocks.map((block) => {
    if (block.type === "text") return { ...block, text: change(block.text) };
    if (block.type === "toolCall")
      return { ...block, arguments: mapStrings(block.arguments, change) };
    return block;
  });
}

/**
 * The model's message with values put back where it wrote placeholders: text and tool-call
 * arguments. Thinking keeps its placeholders, because it goes back to the provider as signed.
 * With `partial`, an unfinished placeholder at the end of a text block is held back.
 */
export function rehydrateMessage(
  message: AssistantMessage,
  vault: Vault,
  partial = false,
): AssistantMessage {
  const text: Text = partial
    ? (value) => vault.rehydrate(withoutPartialPlaceholder(value))
    : (value) => vault.rehydrate(value);
  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type === "text") return { ...block, text: text(block.text) };
      if (block.type === "toolCall")
        return {
          ...block,
          arguments: mapStrings(block.arguments, (value) => vault.rehydrate(value)),
        };
      return block;
    }),
    ...(message.errorMessage === undefined
      ? {}
      : { errorMessage: vault.rehydrate(message.errorMessage) }),
  };
}
