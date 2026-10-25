// Pi's MCP client, for the mcp extension (ADR 12). Its own entry point, so only that extension
// loads it.
export {
  type AuthProvider,
  type CallToolResult,
  McpAuthRequiredError,
  McpClient,
  type McpTransport,
  StdioTransport,
  StreamableHttpTransport,
  type Tool,
  toLlmContent,
} from "@earendil-works/pi-mcp";
export {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  type McpOAuthState,
  type McpOAuthStateStore,
} from "@earendil-works/pi-mcp/oauth";
