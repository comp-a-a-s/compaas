export interface Agent {
  name: string;
  role: string;
  model: string;
  status: string;
  team?: string;
}

export interface Project {
  id: string;
  name: string;
  status: string;
  description?: string;
  type?: string;
  created_at?: string;
  progress?: { done: number; total: number; percentage: number };
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  assigned_to: string;
  priority: string;
  status: string;
  depends_on?: string[];
}

export interface TokenReport {
  total_records: number;
  grand_total_tokens: number;
  by_agent: Record<string, { model: string; total_tokens: number; task_count: number }>;
  by_model: Record<string, { total_tokens: number; task_count: number }>;
}
