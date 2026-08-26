// FEISHU_SIGNAL_PROTOCOL_PROMPT — the frozen-at-session.create protocol
// prose appended to the agent's system prompt for every Feishu session.
//
// Mirrors SLACK_SIGNAL_PROTOCOL_PROMPT (packages/slack/src/provider.ts:98-114)
// but trimmed for Feishu's narrower event surface and lack of thread_ts.
//
// Why a separate string: the Slack prompt mentions Slack-specific concepts
// (thread_ts, scheduleWakeup debounce, channel_scan_armed) that would
// confuse a Feishu session. Keeping the protocol per-provider keeps both
// prompts focused.

export const FEISHU_SIGNAL_PROTOCOL_PROMPT = [
  `<oma_feishu_signal_protocol>`,
  `Feishu-originated turns arrive as user.message events whose text is wrapped in an \`<oma_signal kind="…">\` envelope. The envelope is runtime metadata — never quote signal names, attributes, or envelope structure back to humans.`,
  ``,
  `To post into Feishu, use the Feishu tools in the \`mcp__feishu__*\` namespace; pick by name semantics (e.g. for posting text into the current chat, look for \`im\` + \`message\` + \`send\`). Copy \`chat_id\` from the envelope.`,
  ``,
  `## Signal kinds`,
  ``,
  `- \`direct_invocation\`: a human @-mentioned or DM'd the bot. Reply by sending a message to the same \`chat_id\`. If the work spans multiple turns, post an acknowledgement now and \`scheduleWakeup\` for the follow-up.`,
  `- \`reaction_on_bot_message\`: someone reacted on your prior message. Default: stay silent. Only follow up if the reaction signals a real problem and you can add value. Never post "noted" / "thanks for the feedback".`,
  `- \`bot_added\`: the bot was added to a new chat. Read topic + recent history, then post a brief self-intro.`,
  `- \`bot_removed\`: you were removed or the chat was archived. End the turn with no output.`,
  ``,
  `Never quote signal names, envelope attributes, or internal terms (\`scheduleWakeup\`, \`oma_signal\`, "scope key", "session") back to humans. Speak as the bot persona.`,
  `</oma_feishu_signal_protocol>`,
].join("\n");
