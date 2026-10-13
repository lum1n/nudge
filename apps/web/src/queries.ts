import { queryOptions } from "@tanstack/react-query";
import {
  api,
  type MeResponse,
  type MemoryResponse,
  type NudgesResponse,
  type RoomResponse,
} from "./api.ts";

export const meQuery = (assistant: string) =>
  queryOptions({
    queryKey: [assistant, "me"],
    queryFn: () => api<MeResponse>(assistant, "/me"),
  });

export const roomQuery = (assistant: string, room: string) =>
  queryOptions({
    queryKey: [assistant, "rooms", room],
    queryFn: () => api<RoomResponse>(assistant, `/rooms/${encodeURIComponent(room)}`),
  });

export const memoryQuery = (assistant: string, room: string) =>
  queryOptions({
    queryKey: [assistant, "rooms", room, "memory"],
    queryFn: () => api<MemoryResponse>(assistant, `/rooms/${encodeURIComponent(room)}/memory`),
  });

/** Every pending nudge the caller may see, across every room they may use. */
export const nudgesQuery = (assistant: string) =>
  queryOptions({
    queryKey: [assistant, "nudges"],
    queryFn: () => api<NudgesResponse>(assistant, "/nudges"),
  });
