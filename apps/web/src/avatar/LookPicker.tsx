import { m } from "../i18n/index.ts";
import { ACCESSORIES, type Appearance, EYE_SHAPES, PRESETS } from "./appearance.ts";

/** The choices of a robot's look: a preset to start from, its colours, its eyes and what it wears. */
export function LookPicker({
  look,
  onChange,
}: {
  look: Appearance;
  onChange: (look: Appearance) => void;
}) {
  const setLook = onChange;
  const button = (on: boolean) =>
    `rounded-full border px-3 py-1 text-sm capitalize ${
      on ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-700"
    }`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(PRESETS).map(([name, preset]) => (
          <button
            key={name}
            type="button"
            className={button(sameLook(look, preset))}
            onClick={() => setLook(preset)}
          >
            <span
              className="mr-1.5 inline-block size-3 rounded-full align-[-1px]"
              style={{
                background: `linear-gradient(135deg, ${preset.body[0]}, ${preset.body[1]})`,
              }}
            />
            {m.setup.look.presets[name] ?? name}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <Colour
          label={m.setup.look.ribbon}
          value={look.body[0]}
          onChange={(c) => setLook({ ...look, body: [c, look.body[1]] })}
        />
        <Colour
          label={m.setup.look.ribbonEnd}
          value={look.body[1]}
          onChange={(c) => setLook({ ...look, body: [look.body[0], c] })}
        />
        <Colour
          label={m.setup.look.eyeColour}
          value={look.eyes}
          onChange={(c) => setLook({ ...look, eyes: c })}
        />
        <Colour
          label={m.setup.look.sparks}
          value={look.sparks}
          onChange={(c) => setLook({ ...look, sparks: c })}
        />
      </div>
      <Choice
        label={m.setup.look.eyes}
        options={EYE_SHAPES}
        name={(shape) => m.setup.look.eyeShapes[shape]}
        value={look.eyeShape}
        onChange={(eyeShape) => setLook({ ...look, eyeShape })}
      />
      <Choice
        label={m.setup.look.wears}
        options={ACCESSORIES}
        name={(accessory) => m.setup.look.accessories[accessory]}
        value={look.accessory}
        onChange={(accessory) => setLook({ ...look, accessory })}
      />
    </div>
  );
}

function sameLook(a: Appearance, b: Appearance): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function Colour({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (c: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-stone-600">
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 w-9 cursor-pointer rounded border border-stone-300 bg-white"
      />
      {label}
    </label>
  );
}

function Choice<T extends string>({
  label,
  options,
  name,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  /** What an option is called. */
  name: (option: T) => string;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-2 text-sm text-stone-600">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="rounded border border-stone-300 bg-white px-2 py-1 capitalize"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {name(option)}
          </option>
        ))}
      </select>
    </label>
  );
}
