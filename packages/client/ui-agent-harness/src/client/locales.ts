/** Locale bundles for the agent-harness seat on the new-session screen. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'seatHint': '即将开始的这个会话所用的 agent harness',
  'seatHintNamed': '{name}，即将开始的这个会话所用的 agent harness',
  'sessionHint': '本会话运行的 agent harness，创建时即固定',
  'noDescription': '暂无描述。',
} satisfies Record<string, string>

/** Locale keys this surface renders. */
export type AgentHarnessKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'seatHint': 'Agent harness for the session you are about to start',
  'seatHintNamed': '{name}, the agent harness for the session you are about to start',
  'sessionHint': 'The agent harness this session runs, fixed when it was created',
  'noDescription': 'No description.',
} satisfies Record<AgentHarnessKey, string>

/** Japanese dictionary, checked complete against the zh key set. */
export const ja = {
  'seatHint': 'これから開始するセッションで使用する agent harness',
  'seatHintNamed': '{name}、これから開始するセッションで使用する agent harness',
  'sessionHint': 'このセッションが実行する agent harness。作成時に固定されます',
  'noDescription': '説明はありません。',
} satisfies Record<AgentHarnessKey, string>

/** Spanish dictionary, checked complete against the zh key set. */
export const es = {
  'seatHint': 'Agent harness de la sesión que está a punto de iniciar',
  'seatHintNamed': '{name}, el agent harness de la sesión que está a punto de iniciar',
  'sessionHint': 'El agent harness que ejecuta esta sesión, fijado al crearla',
  'noDescription': 'Sin descripción.',
} satisfies Record<AgentHarnessKey, string>

/** French dictionary, checked complete against the zh key set. */
export const fr = {
  'seatHint': "Agent harness de la session que vous allez démarrer",
  'seatHintNamed': "{name}, l'agent harness de la session que vous allez démarrer",
  'sessionHint': "L'agent harness qu'exécute cette session, fixé à sa création",
  'noDescription': 'Aucune description.',
} satisfies Record<AgentHarnessKey, string>

/** German dictionary, checked complete against the zh key set. */
export const de = {
  'seatHint': 'Agent Harness für die Sitzung, die Sie gleich starten',
  'seatHintNamed': '{name}, der Agent Harness für die Sitzung, die Sie gleich starten',
  'sessionHint': 'Der Agent Harness dieser Sitzung, beim Erstellen festgelegt',
  'noDescription': 'Keine Beschreibung.',
} satisfies Record<AgentHarnessKey, string>

/** Russian dictionary, checked complete against the zh key set. */
export const ru = {
  'seatHint': 'Agent harness для сеанса, который вы собираетесь начать',
  'seatHintNamed': '{name} — agent harness для сеанса, который вы собираетесь начать',
  'sessionHint': 'Agent harness этого сеанса, заданный при его создании',
  'noDescription': 'Нет описания.',
} satisfies Record<AgentHarnessKey, string>

/** Portuguese dictionary, checked complete against the zh key set. */
export const pt = {
  'seatHint': 'Agent harness da sessão que você está prestes a iniciar',
  'seatHintNamed': '{name}, o agent harness da sessão que você está prestes a iniciar',
  'sessionHint': 'O agent harness que esta sessão executa, fixado na criação',
  'noDescription': 'Nenhuma descrição.',
} satisfies Record<AgentHarnessKey, string>
