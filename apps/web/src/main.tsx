import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./api.ts";
import { registerServiceWorker } from "./push.ts";
import { routeTree } from "./routeTree.gen.ts";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    // A 401 or 404 won't get better by asking again.
    queries: { retry: (count, error) => !(error instanceof ApiError) && count < 2 },
  },
});

const router = createRouter({ routeTree, context: { queryClient }, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

registerServiceWorker();

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
