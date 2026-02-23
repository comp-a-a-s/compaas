export interface Agent {
  id: string;
  name: string;
  role: string;
  model: string;
  runtime_provider?: string;
  runtime_mode?: string;
  runtime_model?: string;
  runtime_label?: string;
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
  plan_approved?: boolean;
  workspace_path?: string;
  delivery_mode?: 'local' | 'github';
  github_repo?: string;
  github_branch?: string;
  plan_packet?: PlanningPacketStatus;
  metadata?: ProjectMetadata;
}

export interface PlanningPacketStatus {
  ready: boolean;
  missing_items: string[];
  summary: string;
  updated_at?: string;
  total_characters?: number;
  wording?: string;
  sections?: Record<string, {
    path?: string;
    exists?: boolean;
    length?: number;
    looks_template?: boolean;
  }>;
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
  project_id?: string;
  metadata?: Record<string, unknown>;
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
  role: 'user' | 'ceo' | 'system';
  content: string;
  timestamp: string;
  project_id?: string;
}

export interface RunTimelineEntry {
  timestamp: string;
  state: string;
  label: string;
  metadata?: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  project_id: string;
  provider: string;
  mode: string;
  status: string;
  message: string;
  checksum: string;
  sandbox_profile: string;
  tool_budget?: {
    max_commands: number;
    max_runtime_seconds: number;
    max_files_touched: number;
  };
  created_at: string;
  updated_at: string;
  started_at?: string;
  ended_at?: string;
  timeline?: RunTimelineEntry[];
  cancel_requested?: boolean;
  command_count?: number;
  files_touched?: number;
}

export interface ProjectMetadata {
  project_id: string;
  charter?: {
    scope?: string;
    constraints?: string[];
    acceptance_criteria?: string[];
  };
  definition_of_done?: { label: string; done: boolean }[];
  stakeholder_notes?: { timestamp: string; author: string; note: string }[];
  artifacts?: {
    id: string;
    timestamp: string;
    file_path: string;
    action: string;
    run_id?: string;
    agent?: string;
  }[];
  branch_policy?: {
    pattern?: string;
    enforced?: boolean;
    merge_strategy?: string;
  };
  dependency_graph?: {
    nodes?: string[];
    edges?: { from: string; to: string; label?: string }[];
  };
  archived?: boolean;
}

export interface FeatureFlags {
  planning_approval_gate?: boolean;
  structured_ceo_response?: boolean;
  explain_delegation?: boolean;
  no_delegation_mode?: boolean;
  execution_intent_classifier?: boolean;
  run_replay?: boolean;
  memory_scopes?: boolean;
  memory_retention?: boolean;
  auto_chat_summarization?: boolean;
  prompt_injection_guard?: boolean;
  tool_budget_guardrails?: boolean;
  diff_summary?: boolean;
  github_advanced_controls?: boolean;
  vercel_deploy_lifecycle?: boolean;
  org_chart_advanced_layouts?: boolean;
  ui_global_search?: boolean;
  onboarding_tours?: boolean;
}

export interface LlmConfig {
  /** "anthropic" | "openai" | "openai_compat" */
  provider: 'anthropic' | 'openai' | 'openai_compat';
  /** Anthropic runtime mode (Claude Code CLI with local login or API key from config) */
  anthropic_mode?: 'cli' | 'apikey';
  /** OpenAI runtime mode (direct API or local Codex CLI runtime) */
  openai_mode?: 'apikey' | 'codex';
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
  integrations?: {
    github_token?: string;
    github_repo?: string;
    github_default_branch?: string;
    github_auto_push?: boolean;
    github_auto_pr?: boolean;
    workspace_mode?: 'local' | 'github';
    vercel_token?: string;
    vercel_team_id?: string;
    vercel_project_name?: string;
    slack_token?: string;
    webhook_url?: string;
  };
  chat_policy?: {
    memory_scope?: 'global' | 'project' | 'session-only';
    retention_days?: number;
    auto_summary_every_messages?: number;
  };
  feature_flags?: FeatureFlags;
  routing_models?: Record<string, string>;
  llm: LlmConfig;
}
