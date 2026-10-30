import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { cardProblem, type UiCard, UI_CARD_MAX_CHARS, UiCardContent } from "./card.ts";
import { UiCardInvalid, UiCardNotFound, type UiPresses } from "./presses.ts";

/**
 * `show_ui`: the model shows a card in the transcript (ADR 27). A press on one of its buttons
 * comes back as a message from whoever pressed it, naming the button and the values filled in.
 */
export function createUiTools(ui?: () => UiPresses): ToolRegistration[] {
  const showUi = defineTool({
    name: "show_ui",
    description:
      "Show a card in the chat with blocks (heading, markdown text, key-value pairs, a list, a " +
      "table, an image attachment by id, a divider, a map, a chart, stats, progress bars, a " +
      "timeline), fields to fill in and up to 6 buttons. Use it when people pick between a few " +
      "options, fill in several values, or compare things side by side; not for plain answers, " +
      "which stay text. A `map` shows places by lat/lon with a label each, and a `path` for a " +
      "route. A `chart` is `bar` (comparing amounts), `line` or `area` (change over time) or " +
      "`pie` (parts of one whole, one series, up to 8 slices); give a value per label in each " +
      "series, and keep two measures of different scale in two charts. `stats` is a few headline " +
      "numbers with what changed; `progress` is how far along things are; `timeline` is steps " +
      "in order. An `event` is something for a calendar (start and end as a day, or a time with " +
      "its offset such as 2026-11-03T18:00+01:00), which people can add to theirs. A `diagram` " +
      "is boxes (`nodes`) joined by arrows (`edges`), laid out for you. Fields may also be a " +
      "`date` (YYYY-MM-DD), a `time` (HH:MM), `choices` (any of its options, a list) or a " +
      "`range` (a number from `min` to `max` on a slider). A button with a `url` opens that " +
      "page after asking, and doesn't come back to you. " +
      "Nobody has to press: they may also just " +
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
  if (ui === undefined) return [showUi];
  const updateUi = defineTool({
    name: "update_ui",
    description:
      "Show a card you showed earlier with `show_ui` again, changed: the card in the chat " +
      "becomes this one, such as the next step of a delivery, a new total, or a list with an item " +
      "ticked off. `call_id` is that show_ui call's id. Give the whole card, not just what " +
      "changed. Its buttons work again. Use it to keep one card current instead of showing a new " +
      "one each time; show a new card for something new.",
    parameters: Type.Object({
      call_id: Type.String({ description: "The id of the show_ui call that showed the card." }),
      card: UiCardContent,
    }),
    execute: async (args, api, context) => {
      try {
        await ui().update(api.conversationId, args.call_id, { v: 1, ...args.card }, context);
      } catch (error) {
        if (error instanceof UiCardNotFound)
          return {
            output: [{ type: "text", text: `No card from call ${args.call_id} here.` }],
            isError: true,
          };
        if (error instanceof UiCardInvalid)
          return {
            output: [{ type: "text", text: `Not shown: ${error.message}` }],
            isError: true,
          };
        throw error;
      }
      return { output: [{ type: "text", text: `Updated the card from ${args.call_id}.` }] };
    },
  });
  return [showUi, updateUi];
}
