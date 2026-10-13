import { queryOptions } from "@tanstack/react-query";
import { api, type MeResponse, type RoomResponse } from "./api.ts";

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
