import { common } from "./en/common.ts";
import { panels } from "./en/panels.ts";
import { profile } from "./en/profile.ts";
import { room } from "./en/room.ts";
import { settings } from "./en/settings.ts";
import { setup } from "./en/setup.ts";

/** English, which every other language has to match key for key. */
export const en = { common, panels, profile, room, settings, setup };

export type Messages = typeof en;
