export interface Agent {
  id: string;
  name: string;
  role: string;
  model: string;
  status: string;
  team?: string;
  expertise?: string;
  hired_at?: string;
  description?: string;
  tools?: string;
  assigned_tasks?: TaskWithProject[];
  recent_activity?: ActivityEvent[];
}

export interface Project {
  id: string;
  name: string;
  status: string;
  description?: string;
  type?: string;
  created_at?: string;
  updated_at?: string;
  phases?: string[];
  team?: string[];
  task_counts?: Record<string, number>;
  total_tasks?: number;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  assigned_to: string;
  priority: string;
  status: string;
  depends_on?: string[];
  created_at?: string;
  updated_at?: string;
  notes?: { text: string; at: string }[];
}

export interface TaskWithProject extends Task {
  project_id: string;
  project_name: string;
}

export interface Decision {
  title: string;
  decision: string;
  rationale: string;
  decided_by: string;
  alternatives?: string;
  timestamp: string;
}

export interface ActivityEvent {
  timestamp: string;
  agent: string;
  action: string;
  detail: string;
}

export interface TokenReport {
  total_records: number;
  grand_total_tokens: number;
  by_agent: Record<string, { model: string; total_tokens: number; task_count: number }>;
  by_model: Record<string, { total_tokens: number; task_count: number }>;
  records: TokenRecord[];
}

export interface TokenRecord {
  agent_name: string;
  model: string;
  task_description: string;
  estimated_input_tokens: number;
  estimated_output_tokens: number;
  estimated_total_tokens: number;
  project_id?: string;
  task_id?: string;
  logged_at: string;
}

export interface Budget {
  project_id: string;
  agent_name: string;
  token_limit: number;
  used: number;
  remaining: number;
  usage_percent: number;
  status: string;
}

export interface ChatMessage {
  role: 'user' | 'ceo';
  content: string;
  timestamp: string;
}

export interface LlmConfig {
  /** "anthropic" | "openai" | "openai_compat" */
  provider: 'anthropic' | 'openai' | 'openai_compat';
  /** Base URL for OpenAI-compatible endpoints (OpenAI, Ollama, LM Studio, …) */
  base_url: string;
  /** Model identifier, e.g. "gpt-4o", "llama3.2", "opus" */
  model: string;
  /** API key — use a placeholder (e.g. "ollama") for local servers */
  api_key: string;
  /** Optional system prompt override for the CEO persona */
  system_prompt: string;
  /** Phase 2: route all agent subprocesses through a LiteLLM proxy */
  proxy_enabled: boolean;
  /** LiteLLM proxy URL, e.g. "http://localhost:4000" */
  proxy_url: string;
}

export interface AppConfig {
  setup_complete: boolean;
  user: { name: string };
  agents: Record<string, string>;
  ui: {
    theme: string;
    poll_interval_ms: number;
  };
  server: {
    host: string;
    port: number;
    auto_open_browser: boolean;
  };
  llm: LlmConfig;
}
