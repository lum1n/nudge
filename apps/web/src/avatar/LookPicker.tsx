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
            {name}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <Colour
          label="Ribbon"
          value={look.body[0]}
          onChange={(c) => setLook({ ...look, body: [c, look.body[1]] })}
        />
        <Colour
          label="Ribbon end"
          value={look.body[1]}
          onChange={(c) => setLook({ ...look, body: [look.body[0], c] })}
        />
        <Colour label="Eyes" value={look.eyes} onChange={(c) => setLook({ ...look, eyes: c })} />
        <Colour
          label="Sparks"
          value={look.sparks}
          onChange={(c) => setLook({ ...look, sparks: c })}
        />
      </div>
      <Choice
        label="Eyes"
        options={EYE_SHAPES}
        value={look.eyeShape}
        onChange={(eyeShape) => setLook({ ...look, eyeShape })}
      />
      <Choice
        label="Wears"
        options={ACCESSORIES}
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
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
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
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}
