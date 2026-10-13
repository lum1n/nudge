import type { JsonValue, Op } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";

/** Documents of the view that stay on the server: `pi.provider` holds the provider session id. */
const HIDDEN_DOCS: readonly string[] = ["pi.provider"];

/** The view as clients get it: without the hidden documents. */
export function publicView(view: ConversationView): ConversationView {
  if (!HIDDEN_DOCS.some((kind) => kind in view.docs)) return view;
  return { ...view, docs: withoutHidden(view.docs) };
}

/**
 * One commit's ops as clients get them: ops inside a hidden document are dropped, and values that
 * hold one (a whole-view replacement, or the whole `docs` object) lose it.
 */
export function publicOps(ops: readonly Op[]): Op[] {
  return ops.flatMap((op): Op[] => {
    if (op[0] === "r") return [["r", asJson(publicView(op[1] as unknown as ConversationView))]];
    const [first, second] = op[1];
    if (first !== "docs") return [op];
    if (second === undefined)
      return op[0] === "s"
        ? [["s", op[1], asJson(withoutHidden(op[2] as ConversationView["docs"]))]]
        : [op];
    return HIDDEN_DOCS.includes(second as string) ? [] : [op];
  });
}

function withoutHidden<T extends ConversationView["docs"]>(docs: T): T {
  return Object.fromEntries(
    Object.entries(docs).filter(([kind]) => !HIDDEN_DOCS.includes(kind)),
  ) as T;
}

const asJson = (value: object) => value as unknown as JsonValue;
