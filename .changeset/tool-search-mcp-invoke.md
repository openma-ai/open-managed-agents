---
"@openma/sdk": patch
---

Document how deferred MCP tools are called when the model cannot declare tools mid-conversation: the tool list stays fixed and found tools are called through `mcp_invoke`. Document `tool_search_deferred_hints`, whose default now follows that mode.
