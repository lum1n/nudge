import type { UiBlock } from "@nudge/client";

type DiagramBlock = Extract<UiBlock, { type: "diagram" }>;

const BOX_WIDTH = 132;
const BOX_HEIGHT = 40;
/** Between boxes in a row, and between rows. */
const GAP = 20;
const RANK_GAP = 44;

/**
 * A card's diagram: boxes in rows by where the arrows lead (columns when it goes `right`), each
 * arrow from one box's edge to the next's. The other apps lay it out the same way.
 */
export function CardDiagram(props: { block: DiagramBlock }) {
  const { block } = props;
  const across = block.direction === "right";
  const { rank, order, ranks } = layout(block);
  const widest = Math.max(...ranks.map((row) => row.length));
  const size = (count: number, box: number, gap: number) => count * box + (count - 1) * gap;
  // Each row is centred on the widest.
  const spread = across ? size(widest, BOX_HEIGHT, GAP) : size(widest, BOX_WIDTH, GAP);
  const box = (id: string) => {
    const row = ranks[rank.get(id)!]!;
    const inRow = across ? size(row.length, BOX_HEIGHT, GAP) : size(row.length, BOX_WIDTH, GAP);
    const offset =
      (spread - inRow) / 2 + order.get(id)! * ((across ? BOX_HEIGHT : BOX_WIDTH) + GAP);
    const step = rank.get(id)! * ((across ? BOX_WIDTH : BOX_HEIGHT) + RANK_GAP);
    return across ? { x: step, y: offset } : { x: offset, y: step };
  };
  const width = across ? size(ranks.length, BOX_WIDTH, RANK_GAP) : spread;
  const height = across ? spread : size(ranks.length, BOX_HEIGHT, RANK_GAP);
  const pad = 4;

  return (
    <div className="max-w-full overflow-x-auto">
      <svg
        viewBox={`${-pad} ${-pad} ${width + 2 * pad} ${height + 2 * pad}`}
        width={width + 2 * pad}
        className="max-w-full"
        role="img"
        aria-label={(block.edges ?? [])
          .map((edge) => `${labelOf(block, edge.from)} → ${labelOf(block, edge.to)}`)
          .join(", ")}
      >
        <defs>
          <marker
            id="card-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 Z" fill="#78716c" />
          </marker>
        </defs>
        {(block.edges ?? []).map((edge, index) => {
          const [from, to] = [box(edge.from), box(edge.to)];
          const [x1, y1, x2, y2] = ends(from, to, across);
          return (
            <g key={index}>
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#78716c"
                strokeWidth={1.5}
                markerEnd="url(#card-arrow)"
              />
              {edge.label !== undefined && (
                <text
                  x={(x1 + x2) / 2}
                  y={(y1 + y2) / 2}
                  dy="0.35em"
                  textAnchor="middle"
                  fontSize={11}
                  fill="#57534e"
                  stroke="white"
                  strokeWidth={4}
                  paintOrder="stroke"
                >
                  {edge.label}
                </text>
              )}
            </g>
          );
        })}
        {block.nodes.map((node) => {
          const { x, y } = box(node.id);
          const lines = wrap(node.label);
          return (
            <g key={node.id}>
              <title>{node.label}</title>
              <rect
                x={x}
                y={y}
                width={BOX_WIDTH}
                height={BOX_HEIGHT}
                rx={6}
                fill="#f5f5f4"
                stroke="#a8a29e"
              />
              {lines.map((line, index) => (
                <text
                  key={index}
                  x={x + BOX_WIDTH / 2}
                  y={y + BOX_HEIGHT / 2 + (index - (lines.length - 1) / 2) * 14}
                  dy="0.35em"
                  textAnchor="middle"
                  fontSize={12}
                  fill="#1c1917"
                >
                  {line}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function labelOf(block: DiagramBlock, id: string): string {
  return block.nodes.find((node) => node.id === id)?.label ?? id;
}

/** Where an arrow between two boxes starts and ends: the facing edges' middles. */
function ends(
  from: { x: number; y: number },
  to: { x: number; y: number },
  across: boolean,
): [number, number, number, number] {
  const [fx, fy, tx, ty] = [
    from.x + BOX_WIDTH / 2,
    from.y + BOX_HEIGHT / 2,
    to.x + BOX_WIDTH / 2,
    to.y + BOX_HEIGHT / 2,
  ];
  if (across) {
    const forward = tx >= fx;
    const half = BOX_WIDTH / 2;
    if (tx === fx) return [fx, fy + BOX_HEIGHT / 2, tx, ty - BOX_HEIGHT / 2];
    return [fx + (forward ? half : -half), fy, tx + (forward ? -half : half), ty];
  }
  const down = ty >= fy;
  const half = BOX_HEIGHT / 2;
  if (ty === fy) return [fx + BOX_WIDTH / 2, fy, tx - BOX_WIDTH / 2, ty];
  return [fx, fy + (down ? half : -half), tx, ty + (down ? -half : half)];
}

/** A label in at most two lines of about 18 characters, cut with an ellipsis. */
function wrap(label: string): string[] {
  const width = 18;
  const lines: string[] = [];
  let line = "";
  for (const word of label.split(/\s+/)) {
    if (line === "") line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  const kept = lines
    .slice(0, 2)
    .map((one) => (one.length > width ? `${one.slice(0, width - 1)}…` : one));
  if (lines.length > 2) kept[1] = `${kept[1]!.slice(0, width - 1)}…`;
  return kept;
}

/**
 * Each node's row: one past the furthest row of the nodes with arrows to it, so arrows point down.
 * A cycle is broken at its earliest node. Within a row, nodes sit under the middle of where their
 * arrows come from.
 */
export function layout(block: DiagramBlock) {
  const ids = block.nodes.map((node) => node.id);
  const edges = (block.edges ?? []).filter((edge) => edge.from !== edge.to);
  const into = new Map(
    ids.map((id) => [id, edges.filter((edge) => edge.to === id).map((edge) => edge.from)]),
  );
  const rank = new Map<string, number>();
  const placed = new Set<string>();
  while (placed.size < ids.length) {
    // The next node whose arrows all come from placed nodes; in a cycle, the earliest left.
    const ready =
      ids.find((id) => !placed.has(id) && into.get(id)!.every((from) => placed.has(from))) ??
      ids.find((id) => !placed.has(id))!;
    const from = into.get(ready)!.filter((one) => placed.has(one));
    rank.set(ready, from.length === 0 ? 0 : Math.max(...from.map((one) => rank.get(one)!)) + 1);
    placed.add(ready);
  }
  const ranks: string[][] = [];
  for (const id of ids) (ranks[rank.get(id)!] ??= []).push(id);
  for (let r = 0; r < ranks.length; r++) ranks[r] ??= [];
  const order = new Map<string, number>();
  ranks.forEach((row, r) => {
    if (r > 0) {
      const middle = (id: string) => {
        const from = into.get(id)!.filter((one) => rank.get(one) === r - 1);
        return from.length === 0
          ? Number.POSITIVE_INFINITY
          : from.reduce((sum, one) => sum + order.get(one)!, 0) / from.length;
      };
      // A stable sort keeps the card's order among equals.
      row.sort((a, b) => middle(a) - middle(b) || ids.indexOf(a) - ids.indexOf(b));
    }
    row.forEach((id, index) => order.set(id, index));
  });
  return { rank, order, ranks: ranks.filter((row) => row.length > 0) };
}
