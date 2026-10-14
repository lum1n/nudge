import { queryOptions } from "@tanstack/react-query";
import { clientFor, listAssistants } from "./api.ts";

export const meQuery = (assistant: string) =>
  queryOptions({
    queryKey: [assistant, "me"],
    queryFn: () => clientFor(assistant).api.me(),
  });

/** The assistants this server hosts, with their display names; needs no token. */
export const assistantsQuery = () =>
  queryOptions({
    queryKey: ["assistants"],
    queryFn: () => listAssistants(""),
    staleTime: Infinity,
  });
