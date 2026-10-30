import type { UiBlock } from "@nudge/client";

type ChartBlock = Extract<UiBlock, { type: "chart" }>;

/**
 * The series' colours, in this order and never cycled: each pair next to each other stays apart
 * for colour-blind readers too. A chart takes 6 series and a pie 8 slices, so none repeats.
 */
const COLORS = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#6250d6",
  "#e34948",
];
const WIDTH = 400;
const HEIGHT = 190;
const LEFT = 44;
const RIGHT = 8;
const TOP = 8;
const BOTTOM = 22;

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** A card's chart, drawn as SVG; hovering a mark says its value. */
export function CardChart(props: { block: ChartBlock }) {
  const { block } = props;
  const said = (value: number) => `${full.format(value)}${block.unit ? ` ${block.unit}` : ""}`;
  if (block.kind === "pie") return <Pie block={block} said={said} />;
  return (
    <figure className="flex flex-col gap-1">
      {block.series.length > 1 && <Legend names={block.series.map((series) => series.name)} />}
      <Plot block={block} said={said} />
    </figure>
  );
}

function Legend(props: { names: readonly string[]; values?: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-stone-600">
      {props.names.map((name, index) => (
        <li key={index} className="flex items-center gap-1">
          <span
            className="inline-block size-2.5 rounded-sm"
            style={{ backgroundColor: COLORS[index] }}
          />
          {name}
          {props.values?.[index] !== undefined && (
            <span className="text-stone-500">{props.values[index]}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Plot(props: { block: ChartBlock; said: (value: number) => string }) {
  const { block, said } = props;
  const { labels, series } = block;
  const values = series.flatMap((one) => one.values.filter((value) => value !== null));
  const axis = ticks(Math.min(0, ...values), Math.max(0, ...values));
  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const y = (value: number) =>
    TOP + plotHeight - ((value - axis.min) / (axis.max - axis.min)) * plotHeight;
  const band = plotWidth / labels.length;
  // Bars sit in their band; a line's points sit at the band's middle, so both share the x labels.
  const x = (index: number) => LEFT + band * index + band / 2;
  const every = Math.ceil(labels.length / 8);
  const unit = block.unit ? ` ${block.unit}` : "";

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img">
      {axis.values.map((tick) => (
        <g key={tick}>
          <line
            x1={LEFT}
            x2={WIDTH - RIGHT}
            y1={y(tick)}
            y2={y(tick)}
            stroke={tick === 0 ? "#a8a29e" : "#e7e5e4"}
          />
          <text x={LEFT - 6} y={y(tick)} dy="0.32em" textAnchor="end" fontSize={12} fill="#78716c">
            {compact.format(tick)}
          </text>
        </g>
      ))}
      {labels.map((label, index) =>
        index % every === 0 ? (
          <text
            key={index}
            x={x(index)}
            y={HEIGHT - 6}
            textAnchor="middle"
            fontSize={12}
            fill="#78716c"
          >
            {label.length > 10 ? `${label.slice(0, 9)}…` : label}
          </text>
        ) : null,
      )}
      {block.kind === "bar"
        ? series.map((one, s) => {
            const width = Math.max(2, (band * 0.72) / series.length - 2);
            return one.values.map((value, index) =>
              value === null ? null : (
                <path
                  key={`${s}/${index}`}
                  d={bar(
                    LEFT + band * index + band * 0.14 + s * (width + 2),
                    y(0),
                    y(value),
                    width,
                  )}
                  fill={COLORS[s]}
                >
                  <title>{`${labels[index]} · ${one.name}: ${said(value)}`}</title>
                </path>
              ),
            );
          })
        : series.map((one, s) => (
            <g key={s}>
              {runs(one.values).map((run, r) => {
                const line = run.map((index) => `${x(index)},${y(one.values[index]!)}`).join(" ");
                return (
                  <g key={r}>
                    {block.kind === "area" && run.length > 1 && (
                      <polygon
                        points={`${x(run[0]!)},${y(0)} ${line} ${x(run.at(-1)!)},${y(0)}`}
                        fill={COLORS[s]}
                        fillOpacity={series.length > 1 ? 0.12 : 0.2}
                      />
                    )}
                    <polyline
                      points={line}
                      fill="none"
                      stroke={COLORS[s]}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  </g>
                );
              })}
              {labels.length <= 24 &&
                one.values.map((value, index) =>
                  value === null ? null : (
                    <circle
                      key={index}
                      cx={x(index)}
                      cy={y(value)}
                      r={3.5}
                      fill={COLORS[s]}
                      stroke="white"
                      strokeWidth={2}
                    />
                  ),
                )}
            </g>
          ))}
      {block.kind !== "bar" &&
        // A strip per label, wider than the marks, says every series' value there.
        labels.map((label, index) => (
          <rect
            key={index}
            x={LEFT + band * index}
            y={TOP}
            width={band}
            height={plotHeight}
            fill="transparent"
            className="hover:fill-stone-500/10"
          >
            <title>
              {[
                label,
                ...series.map(
                  (one) =>
                    `${one.name}: ${one.values[index] === null || one.values[index] === undefined ? "–" : said(one.values[index]!)}`,
                ),
              ].join("\n")}
            </title>
          </rect>
        ))}
      <desc>{`${series.map((one) => one.name).join(", ")}${unit}`}</desc>
    </svg>
  );
}

function Pie(props: { block: ChartBlock; said: (value: number) => string }) {
  const { block, said } = props;
  const values = (block.series[0]?.values ?? []).map((value) => Math.max(0, value ?? 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const radius = 70;
  const inner = 42;
  let angle = -Math.PI / 2;
  return (
    <figure className="flex flex-wrap items-center gap-4">
      <svg viewBox="-80 -80 160 160" className="size-36 shrink-0" role="img">
        {total === 0 ? (
          <circle
            r={(radius + inner) / 2}
            fill="none"
            stroke="#e7e5e4"
            strokeWidth={radius - inner}
          />
        ) : (
          values.map((value, index) => {
            const start = angle;
            angle += (value / total) * Math.PI * 2;
            if (value === 0) return null;
            return (
              <path
                key={index}
                d={slice(start, angle, radius, inner)}
                fill={COLORS[index]}
                stroke="white"
                strokeWidth={2}
              >
                <title>{`${block.labels[index]}: ${said(value)}`}</title>
              </path>
            );
          })
        )}
      </svg>
      <Legend
        names={block.labels}
        values={values.map((value) =>
          total === 0 ? "" : `${said(value)} · ${Math.round((value / total) * 100)}%`,
        )}
      />
    </figure>
  );
}

/** The indexes of each unbroken run of values, so a null leaves a gap in the line. */
function runs(values: readonly (number | null)[]): number[][] {
  const found: number[][] = [];
  let current: number[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) found.push(current);
      current = [];
    } else current.push(index);
  });
  if (current.length > 0) found.push(current);
  return found;
}

/** A bar from `base` to `end`, rounded at the end away from the baseline. */
function bar(left: number, base: number, end: number, width: number): string {
  const r = Math.min(4, width / 2, Math.abs(base - end));
  const up = end <= base;
  const tip = up ? end + r : end - r;
  return [
    `M${left},${base}`,
    `L${left},${tip}`,
    `Q${left},${end} ${left + r},${end}`,
    `L${left + width - r},${end}`,
    `Q${left + width},${end} ${left + width},${tip}`,
    `L${left + width},${base}`,
    "Z",
  ].join(" ");
}

function slice(start: number, end: number, outer: number, inner: number): string {
  // A whole circle as one arc draws nothing, so a lone slice stops just short.
  const stop = end - start >= Math.PI * 2 ? end - 0.0001 : end;
  const large = stop - start > Math.PI ? 1 : 0;
  const at = (angle: number, r: number) => `${r * Math.cos(angle)},${r * Math.sin(angle)}`;
  return [
    `M${at(start, outer)}`,
    `A${outer},${outer} 0 ${large} 1 ${at(stop, outer)}`,
    `L${at(stop, inner)}`,
    `A${inner},${inner} 0 ${large} 0 ${at(start, inner)}`,
    "Z",
  ].join(" ");
}

/** About five round numbers from below `low` to above `high`. */
function ticks(low: number, high: number): { min: number; max: number; values: number[] } {
  if (low === high) high = low + 1;
  const rough = (high - low) / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((n) => n * power).find((n) => n >= rough) ?? rough;
  const min = Math.floor(low / step) * step;
  const max = Math.ceil(high / step) * step;
  const values = [];
  for (let value = min; value <= max + step / 2; value += step)
    values.push(Number(value.toPrecision(12)));
  return { min, max, values };
}
