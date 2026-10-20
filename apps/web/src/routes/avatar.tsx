import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { type Appearance, NUDGE, PRESETS } from "../avatar/appearance.ts";
import { Avatar } from "../avatar/Avatar.tsx";
import { LookPicker } from "../avatar/LookPicker.tsx";
import { type Mood, MOODS } from "../avatar/pose.ts";

// A playground for the robot: every mood, every choice of look, and the sizes the apps draw it at.
export const Route = createFileRoute("/avatar")({
  component: Playground,
  validateSearch: (search: Record<string, unknown>): { mood?: Mood; preset?: string } => ({
    mood: MOODS.includes(search.mood as Mood) ? (search.mood as Mood) : undefined,
    preset: typeof search.preset === "string" ? search.preset : undefined,
  }),
});

/** What a turn looks like, mood by mood, in seconds. */
const STORY: readonly [Mood, number][] = [
  ["idle", 4],
  ["listening", 3],
  ["thinking", 2.5],
  ["working", 3],
  ["thinking", 1.5],
  ["speaking", 4],
  ["happy", 1.6],
  ["idle", 3],
  ["waiting", 3.5],
  ["puzzled", 2.5],
  ["sad", 2.5],
  ["asleep", 4],
];

function Playground() {
  const search = Route.useSearch();
  const [mood, setMood] = useState<Mood>(search.mood ?? "idle");
  const [look, setLook] = useState<Appearance>(PRESETS[search.preset ?? ""] ?? NUDGE);
  const [story, setStory] = useState(search.mood === undefined);
  const [dark, setDark] = useState(false);
  const mic = useMic();

  useEffect(() => {
    if (!story) return;
    let step = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      const [m, seconds] = STORY[step % STORY.length]!;
      setMood(m);
      step += 1;
      timer = setTimeout(next, seconds * 1000);
    };
    next();
    return () => clearTimeout(timer);
  }, [story]);

  const pick = (m: Mood) => {
    setStory(false);
    setMood(m);
  };
  const button = (on: boolean) =>
    `rounded-full border px-3 py-1 text-sm capitalize ${
      on ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-700"
    }`;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-4 sm:p-8">
      <h1 className="text-2xl font-semibold">Nudge</h1>
      <div className="grid gap-6 md:grid-cols-[1fr_20rem]">
        <section
          className={`flex flex-col items-center gap-6 rounded-3xl p-6 transition-colors ${
            dark ? "bg-stone-900" : "bg-white"
          }`}
        >
          <Avatar mood={mood} appearance={look} size={300} level={mic.on ? mic.level : undefined} />
          <p className={`text-sm capitalize ${dark ? "text-stone-400" : "text-stone-500"}`}>
            {mood}
            {story && " · playing a turn"}
          </p>
          <div className="flex items-end gap-5">
            {[20, 28, 40, 64].map((size) => (
              <Avatar key={size} mood={mood} appearance={look} size={size} />
            ))}
          </div>
        </section>

        <aside className="flex flex-col gap-5">
          <Group title="Mood">
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className={button(story)} onClick={() => setStory(true)}>
                Play a turn
              </button>
              {MOODS.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={button(!story && m === mood)}
                  onClick={() => pick(m)}
                >
                  {m}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm text-stone-600">
              <input type="checkbox" checked={mic.on} onChange={() => void mic.toggle()} />
              Follow my voice when listening or speaking
            </label>
            {mic.error && <p className="text-sm text-red-700">{mic.error}</p>}
          </Group>

          <Group title="Look">
            <LookPicker look={look} onChange={setLook} />
          </Group>

          <label className="flex items-center gap-2 text-sm text-stone-600">
            <input type="checkbox" checked={dark} onChange={() => setDark(!dark)} />
            Dark background
          </label>
          <pre className="overflow-x-auto rounded bg-stone-100 p-2 text-xs text-stone-600">
            {JSON.stringify(look, null, 1)}
          </pre>
        </aside>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-stone-500">{title}</h2>
      {children}
    </section>
  );
}

/** The microphone's loudness, 0 to 1, read when asked. */
function useMic() {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string>();
  const analyser = useRef<{ node: AnalyserNode; stop: () => void }>(undefined);
  const buffer = useRef(new Float32Array(1024));

  useEffect(() => () => analyser.current?.stop(), []);

  const toggle = async () => {
    if (analyser.current) {
      analyser.current.stop();
      analyser.current = undefined;
      setOn(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const node = context.createAnalyser();
      node.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(node);
      analyser.current = {
        node,
        stop: () => {
          for (const track of stream.getTracks()) track.stop();
          void context.close();
        },
      };
      setError(undefined);
      setOn(true);
    } catch {
      setError("The browser didn't give the microphone.");
    }
  };

  const level = () => {
    const node = analyser.current?.node;
    if (!node) return 0;
    node.getFloatTimeDomainData(buffer.current);
    let sum = 0;
    for (const x of buffer.current) sum += x * x;
    // Speech is around 0.02 to 0.2 RMS; spread that over 0 to 1.
    return Math.min(1, Math.sqrt(sum / buffer.current.length) * 6);
  };

  return { on, error, toggle, level };
}
