import type { TokenReport, Budget } from '../types';

interface MetricsPanelProps {
  tokenReport: TokenReport | null;
  budgets: Budget[];
  loading: boolean;
}

// ---- Helpers ----
function modelColor(model: string): string {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return '#cba6f7';
  if (m.includes('sonnet')) return '#89b4fa';
  if (m.includes('haiku')) return '#a6e3a1';
  return '#a6adc8';
}

function modelBadge(model: string): { bg: string; text: string } {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return { bg: '#2a1e3a', text: '#cba6f7' };
  if (m.includes('sonnet')) return { bg: '#1e3050', text: '#89b4fa' };
  if (m.includes('haiku')) return { bg: '#1a3020', text: '#a6e3a1' };
  return { bg: '#313244', text: '#a6adc8' };
}

// Cost estimate: very rough approximation
const MODEL_COST_PER_TOKEN: Record<string, number> = {
  opus: 0.000015,
  sonnet: 0.000003,
  haiku: 0.00000025,
};

function estimateCost(model: string, tokens: number): number {
  const m = (model || '').toLowerCase();
  for (const [key, rate] of Object.entries(MODEL_COST_PER_TOKEN)) {
    if (m.includes(key)) return tokens * rate;
  }
  return tokens * 0.000003; // default sonnet rate
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}¢`;
  return `$${usd.toFixed(2)}`;
}

// ---- Skeleton ----
function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded ${className}`} />;
}

// ---- Summary card ----
interface SummaryCardProps {
  label: string;
  value: string;
  sub?: string;
  color: string;
}
function SummaryCard({ label, value, sub, color }: SummaryCardProps) {
  return (
    <div
      className="rounded-xl p-4 flex flex-col gap-1 animate-slide-up"
      style={{ backgroundColor: '#181825', border: '1px solid #45475a' }}
    >
      <p className="text-xs uppercase tracking-widest" style={{ color: '#6c7086' }}>
        {label}
      </p>
      <p className="text-2xl font-bold" style={{ color }}>
        {value}
      </p>
      {sub && (
        <p className="text-xs" style={{ color: '#6c7086' }}>
          {sub}
        </p>
      )}
    </div>
  );
}

// ---- Horizontal bar chart for agents ----
interface AgentBarChartProps {
  byAgent: Record<string, { model: string; total_tokens: number; task_count: number }>;
}
function AgentBarChart({ byAgent }: AgentBarChartProps) {
  const entries = Object.entries(byAgent).sort((a, b) => b[1].total_tokens - a[1].total_tokens);
  if (entries.length === 0) {
    return (
      <p className="text-xs py-4 text-center" style={{ color: '#6c7086' }}>
        No token data available
      </p>
    );
  }

  const maxTokens = Math.max(...entries.map(([, v]) => v.total_tokens));

  return (
    <div className="space-y-3">
      {entries.map(([agentName, data]) => {
        const pct = maxTokens > 0 ? (data.total_tokens / maxTokens) * 100 : 0;
        const color = modelColor(data.model);
        const cost = estimateCost(data.model, data.total_tokens);

        return (
          <div key={agentName} className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0" style={{ flex: '0 0 180px' }}>
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                  style={{ backgroundColor: color, color: '#11111b' }}
                >
                  {agentName.charAt(0).toUpperCase()}
                </div>
                <span className="text-xs font-medium truncate" style={{ color: '#cdd6f4' }}>
                  {agentName}
                </span>
              </div>

              <div className="flex-1 min-w-0">
                <div className="h-5 rounded-md overflow-hidden" style={{ backgroundColor: '#313244' }}>
                  <div
                    className="h-full rounded-md transition-all duration-700"
                    style={{ width: `${pct}%`, backgroundColor: color, opacity: 0.8 }}
                  />
                </div>
              </div>

              <div
                className="text-right flex-shrink-0"
                style={{ flex: '0 0 120px' }}
              >
                <span className="text-xs font-medium" style={{ color }}>
                  {formatTokens(data.total_tokens)}
                </span>
                <span className="text-xs ml-2" style={{ color: '#6c7086' }}>
                  {formatCost(cost)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- Model breakdown table ----
interface ModelTableProps {
  byModel: Record<string, { total_tokens: number; task_count: number }>;
}
function ModelTable({ byModel }: ModelTableProps) {
  const entries = Object.entries(byModel).sort((a, b) => b[1].total_tokens - a[1].total_tokens);

  if (entries.length === 0) {
    return (
      <p className="text-xs py-4 text-center" style={{ color: '#6c7086' }}>
        No model data available
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr style={{ borderBottom: '1px solid #313244' }}>
            {['Model', 'Tokens', 'Tasks', 'Est. Cost'].map((col) => (
              <th
                key={col}
                className="text-left py-2 pr-4 font-semibold uppercase tracking-widest"
                style={{ color: '#6c7086' }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map(([model, data]) => {
            const badge = modelBadge(model);
            const cost = estimateCost(model, data.total_tokens);
            return (
              <tr key={model} style={{ borderBottom: '1px solid #1e1e2e' }}>
                <td className="py-2.5 pr-4">
                  <span
                    className="px-2 py-0.5 rounded-full font-medium"
                    style={{ backgroundColor: badge.bg, color: badge.text }}
                  >
                    {model}
                  </span>
                </td>
                <td className="py-2.5 pr-4 font-medium" style={{ color: '#cdd6f4' }}>
                  {formatTokens(data.total_tokens)}
                </td>
                <td className="py-2.5 pr-4" style={{ color: '#a6adc8' }}>
                  {data.task_count}
                </td>
                <td className="py-2.5" style={{ color: '#a6e3a1' }}>
                  {formatCost(cost)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- Budget card ----
interface BudgetCardProps {
  budget: Budget;
}
function BudgetCard({ budget }: BudgetCardProps) {
  const pct = Math.min(budget.usage_percent, 100);
  const isOver = budget.usage_percent > 100;
  const isWarning = budget.usage_percent > 80;

  const barColor = isOver ? '#f38ba8' : isWarning ? '#f9e2af' : '#a6e3a1';
  const statusText = isOver ? 'OVER BUDGET' : isWarning ? 'WARNING' : 'OK';
  const statusColor = isOver ? '#f38ba8' : isWarning ? '#f9e2af' : '#a6e3a1';
  const statusBg = isOver ? '#3a1a1e' : isWarning ? '#3a3010' : '#1a3020';

  return (
    <div
      className="rounded-xl p-4 flex flex-col gap-3"
      style={{
        backgroundColor: '#181825',
        border: `1px solid ${isOver ? '#f38ba8' : isWarning ? '#f9e2af' : '#45475a'}`,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold" style={{ color: '#cdd6f4' }}>
            {budget.agent_name}
          </p>
          <p className="text-xs mt-0.5" style={{ color: '#6c7086' }}>
            Project: {budget.project_id}
          </p>
        </div>
        <span
          className="text-xs px-2 py-0.5 rounded-full font-semibold flex-shrink-0"
          style={{ backgroundColor: statusBg, color: statusColor }}
        >
          {statusText}
        </span>
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span style={{ color: '#6c7086' }}>
            {formatTokens(budget.used)} / {formatTokens(budget.token_limit)}
          </span>
          <span style={{ color: barColor }}>
            {budget.usage_percent.toFixed(1)}%
          </span>
        </div>
        <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: '#313244' }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, backgroundColor: barColor }}
          />
        </div>
        <p className="text-xs mt-1" style={{ color: '#6c7086' }}>
          {formatTokens(budget.remaining)} remaining
        </p>
      </div>
    </div>
  );
}

// ---- Main MetricsPanel ----
export default function MetricsPanel({ tokenReport, budgets, loading }: MetricsPanelProps) {
  if (loading) {
    return (
      <div className="space-y-6 animate-fade-in">
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="rounded-xl p-4"
              style={{ backgroundColor: '#181825', border: '1px solid #45475a' }}
            >
              <Skeleton className="h-3 w-20 mb-2" />
              <Skeleton className="h-8 w-16" />
            </div>
          ))}
        </div>
        <div
          className="rounded-xl p-5"
          style={{ backgroundColor: '#181825', border: '1px solid #45475a' }}
        >
          <Skeleton className="h-4 w-32 mb-4" />
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Compute totals from report
  const totalTokens = tokenReport?.grand_total_tokens ?? 0;
  const totalTasks = tokenReport?.total_records ?? 0;
  const byAgent = tokenReport?.by_agent ?? {};
  const byModel = tokenReport?.by_model ?? {};

  // Compute estimated total cost across all agents
  const totalCost = Object.values(byAgent).reduce((sum, data) => {
    return sum + estimateCost(data.model, data.total_tokens);
  }, 0);

  const activeBudgets = budgets.filter((b) => b.status === 'active' || b.usage_percent < 100);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Summary cards */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <SummaryCard
          label="Total Tokens"
          value={formatTokens(totalTokens)}
          sub={`${totalTokens.toLocaleString()} tokens`}
          color="#89b4fa"
        />
        <SummaryCard
          label="Total Tasks"
          value={totalTasks.toString()}
          sub="tasks tracked"
          color="#cba6f7"
        />
        <SummaryCard
          label="Est. Cost"
          value={formatCost(totalCost)}
          sub="approximate USD"
          color="#a6e3a1"
        />
        <SummaryCard
          label="Active Budgets"
          value={budgets.length.toString()}
          sub={`${budgets.filter((b) => b.usage_percent > 80).length} warnings`}
          color="#f9e2af"
        />
      </div>

      {/* Token usage by agent */}
      <div
        className="rounded-xl p-5"
        style={{ backgroundColor: '#181825', border: '1px solid #45475a' }}
      >
        <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: '#6c7086' }}>
          Token Usage by Agent
        </h3>
        {Object.keys(byAgent).length === 0 ? (
          <p className="text-xs py-4 text-center" style={{ color: '#6c7086' }}>
            No token usage data available. Check backend connection.
          </p>
        ) : (
          <AgentBarChart byAgent={byAgent} />
        )}
      </div>

      {/* Model breakdown table */}
      <div
        className="rounded-xl p-5"
        style={{ backgroundColor: '#181825', border: '1px solid #45475a' }}
      >
        <h3 className="text-xs font-semibold uppercase tracking-widest mb-4" style={{ color: '#6c7086' }}>
          Model Breakdown
        </h3>
        <ModelTable byModel={byModel} />
      </div>

      {/* Budget status */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#6c7086' }}>
          Budget Status ({budgets.length})
        </h3>
        {budgets.length === 0 ? (
          <div
            className="rounded-xl p-5 text-center"
            style={{ backgroundColor: '#181825', border: '1px solid #45475a' }}
          >
            <p className="text-xs" style={{ color: '#6c7086' }}>
              No budget data available
            </p>
          </div>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {budgets.map((budget, i) => (
              <BudgetCard key={`${budget.project_id}-${budget.agent_name}-${i}`} budget={budget} />
            ))}
          </div>
        )}
      </div>

      {/* Over-budget warnings */}
      {activeBudgets.filter((b) => b.usage_percent > 80).length > 0 && (
        <div
          className="rounded-xl p-4 flex items-start gap-3"
          style={{ backgroundColor: '#2a1510', border: '1px solid #f38ba8' }}
          role="alert"
        >
          <svg
            className="w-4 h-4 flex-shrink-0 mt-0.5"
            style={{ color: '#f38ba8' }}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div>
            <p className="text-xs font-semibold" style={{ color: '#f38ba8' }}>
              Budget Warning
            </p>
            <p className="text-xs mt-0.5" style={{ color: '#fab387' }}>
              {budgets.filter((b) => b.usage_percent > 80).length} budget(s) at over 80% usage. Review token allocations.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
