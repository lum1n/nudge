import type { NudgeEnv } from "../src/config.ts";

declare global {
  namespace Cloudflare {
    interface Env extends NudgeEnv {}
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
      durableNamespaces: "NudgeAssistant";
    }
  }
}
