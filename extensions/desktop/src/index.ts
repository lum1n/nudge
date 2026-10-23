export { default } from "./extension.ts";
export {
  DEFAULT_DESKTOP_MODEL,
  desktopSystemPrompt,
  runDesktopAgent,
  type DesktopAgentOptions,
  type DesktopAgentResult,
  type DesktopStep,
} from "./agent.ts";
export { Atspi, parseKeys, type Address, type Info, type State } from "./atspi.ts";
export { closeAllDesktops, closeDesktop, withDesktop } from "./pool.ts";
export {
  ActionError,
  DesktopSession,
  desktopProblem,
  sweepDesktops,
  type DesktopOptions,
} from "./session.ts";
export {
  renderDesktop,
  roleOf,
  type DesktopNode,
  type DesktopSnapshot,
  type DesktopWindow,
} from "./snapshot.ts";
export {
  desktopTools,
  progressLine,
  runBatch,
  type Desktop,
  type DesktopTool,
  type ToolCallInput,
  type ToolCallOutput,
} from "./tools.ts";
