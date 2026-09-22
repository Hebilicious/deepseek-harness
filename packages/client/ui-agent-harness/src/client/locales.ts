/** Locale bundles for the agent-harness seat on the new-session screen. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'seatHint': '即将开始的这个会话所用的 agent harness',
  'sessionHint': '本会话运行的 agent harness，创建时即固定',
  'noDescription': '暂无描述。',
} satisfies Record<string, string>

/** Locale keys this surface renders. */
export type AgentHarnessKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'seatHint': 'Agent harness for the session you are about to start',
  'sessionHint': 'The agent harness this session runs, fixed when it was created',
  'noDescription': 'No description.',
} satisfies Record<AgentHarnessKey, string>
