// Pi's faux model provider for tests, so extension and host tests depend on @nudge/core alone.
export { createModels } from "@earendil-works/pi-ai/models";
export {
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseFactory,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
