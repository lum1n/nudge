import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { cardProblem, type UiCard, UI_CARD_MAX_CHARS, UiCardContent } from "./card.ts";

/**
 * `show_ui`: the model shows a card in the transcript (ADR 27). A press on one of its buttons
 * comes back as a message from whoever pressed it, naming the button and the values filled in.
 */
export function createUiTools(): ToolRegistration[] {
  const showUi = defineTool({
    name: "show_ui",
    description:
      "Show a card in the chat with blocks (heading, markdown text, key-value pairs, a list, a " +
      "table, an image attachment by id, a divider), fields to fill in and up to 6 buttons. Use " +
      "it when people pick between a few options, fill in several values, or compare things side " +
      "by side; not for plain answers, which stay text. Nobody has to press: they may also just " +
      'write. A press comes back as a message such as `Pressed "Book" on "Times"` with a line ' +
      "per field; answer it as you would that message. Buttons work once unless `once` is false. " +
      '`who: "asker"` lets only who you answer press. Fields\' values reach you, so never ask ' +
      "for passwords or keys with them. Don't repeat the card's content in your text.",
    parameters: UiCardContent,
    execute: async (args) => {
      const card: UiCard = { v: 1, ...args };
      const size = JSON.stringify(card).length;
      const problem =
        cardProblem(card) ??
        (size > UI_CARD_MAX_CHARS
          ? `it is ${size} characters as JSON, over ${UI_CARD_MAX_CHARS}; shorten it`
          : undefined);
      if (problem !== undefined)
        return { output: [{ type: "text", text: `Not shown: ${problem}` }], isError: true };
      const buttons = (card.buttons ?? []).map((button) => `"${button.label}"`).join(", ");
      const summary =
        `Shown${card.title === undefined ? "" : ` "${card.title}"`}` +
        (buttons === "" ? "." : ` with ${buttons}; a press comes back as a message.`);
      return { output: [{ type: "text", text: summary }], details: { ui: card } };
    },
  });
  return [showUi];
}
