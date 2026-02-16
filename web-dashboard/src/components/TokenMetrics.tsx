import type { TokenReport } from '../types';

interface TokenMetricsProps {
  report: TokenReport | null;
  loading: boolean;
}

// Rough cost estimate per 1M tokens (blended input/output, approximate)
const COST_PER_M: Record<string, number> = {
  'claude-opus': 18.75,      // $15/$75 averaged
  'claude-sonnet': 4.5,      // $3/$15 averaged
  'claude-haiku': 0.5,       // $0.25/$1.25 averaged
  'default': 4.5,
};

function estimateCost(byModel: TokenReport['by_model']): number {
  let total = 0;
  for (const [model, data] of Object.entries(byModel)) {
    const lower = model.toLowerCase();
    let rate = COST_PER_M['default'];
    if (lower.includes('opus')) rate = COST_PER_M['claude-opus'];
    else if (lower.includes('sonnet')) rate = COST_PER_M['claude-sonnet'];
    else if (lower.includes('haiku')) rate = COST_PER_M['claude-haiku'];
    total += (data.total_tokens / 1_000_000) * rate;
  }
  return total;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function modelColor(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'bg-violet-500';
  if (lower.includes('sonnet')) return 'bg-blue-500';
  if (lower.includes('haiku')) return 'bg-green-500';
  return 'bg-gray-500';
}

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
      <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-2xl font-bold text-white leading-tight">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 animate-pulse">
      <div className="h-3 bg-gray-700 rounded w-24 mb-2" />
      <div className="h-7 bg-gray-700 rounded w-32" />
    </div>
  );
}

export default function TokenMetrics({ report, loading }: TokenMetricsProps) {
  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
        Token metrics unavailable. The backend may not support this endpoint yet.
      </div>
    );
  }

  const costEstimate = estimateCost(report.by_model);
  const agentEntries = Object.entries(report.by_agent).sort((a, b) => b[1].total_tokens - a[1].total_tokens);
  const modelEntries = Object.entries(report.by_model).sort((a, b) => b[1].total_tokens - a[1].total_tokens);
  const maxAgentTokens = agentEntries[0]?.[1].total_tokens ?? 1;

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryCard
          label="Total Tokens"
          value={formatTokens(report.grand_total_tokens)}
          sub={`${report.total_records.toLocaleString()} records`}
        />
        <SummaryCard
          label="Total Tasks"
          value={String(Object.values(report.by_agent).reduce((s, a) => s + a.task_count, 0))}
          sub={`${Object.keys(report.by_agent).length} active agents`}
        />
        <SummaryCard
          label="Est. Cost"
          value={`$${costEstimate.toFixed(2)}`}
          sub="Approximate blended rate"
        />
      </div>

      {/* Tokens per agent bar chart */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-200 mb-4">Tokens per Agent</h3>
        {agentEntries.length === 0 ? (
          <p className="text-xs text-gray-500">No agent data available.</p>
        ) : (
          <div className="space-y-2" role="list" aria-label="Token usage by agent">
            {agentEntries.map(([agent, data]) => {
              const pct = (data.total_tokens / maxAgentTokens) * 100;
              const barColor = modelColor(data.model);
              return (
                <div key={agent} className="flex items-center gap-3" role="listitem">
                  <span className="text-xs text-gray-400 w-32 truncate flex-shrink-0" title={agent}>{agent}</span>
                  <div className="flex-1 h-4 bg-gray-700 rounded-full overflow-hidden" role="img" aria-label={`${agent}: ${formatTokens(data.total_tokens)} tokens`}>
                    <div
                      className={`h-full ${barColor} rounded-full transition-all duration-500`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-300 font-mono w-14 text-right flex-shrink-0">
                    {formatTokens(data.total_tokens)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Per-model breakdown table */}
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-200 mb-4">Model Breakdown</h3>
        {modelEntries.length === 0 ? (
          <p className="text-xs text-gray-500">No model data available.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" aria-label="Model token breakdown">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left text-gray-400 font-semibold pb-2 pr-4">Model</th>
                  <th className="text-right text-gray-400 font-semibold pb-2 pr-4">Total Tokens</th>
                  <th className="text-right text-gray-400 font-semibold pb-2 pr-4">Tasks</th>
                  <th className="text-right text-gray-400 font-semibold pb-2">Est. Cost</th>
                </tr>
              </thead>
              <tbody>
                {modelEntries.map(([model, data]) => {
                  const lower = model.toLowerCase();
                  let rate = COST_PER_M['default'];
                  if (lower.includes('opus')) rate = COST_PER_M['claude-opus'];
                  else if (lower.includes('sonnet')) rate = COST_PER_M['claude-sonnet'];
                  else if (lower.includes('haiku')) rate = COST_PER_M['claude-haiku'];
                  const modelCost = (data.total_tokens / 1_000_000) * rate;
                  return (
                    <tr key={model} className="border-b border-gray-700/50 last:border-0">
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${modelColor(model)}`} aria-hidden="true" />
                          <span className="text-gray-200 font-mono truncate max-w-48">{model}</span>
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-right text-gray-300 font-mono">{formatTokens(data.total_tokens)}</td>
                      <td className="py-2 pr-4 text-right text-gray-300">{data.task_count}</td>
                      <td className="py-2 text-right text-gray-300">${modelCost.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-600">
                  <td className="pt-2 text-gray-300 font-semibold">Total</td>
                  <td className="pt-2 text-right text-gray-200 font-semibold font-mono">{formatTokens(report.grand_total_tokens)}</td>
                  <td className="pt-2 text-right text-gray-200 font-semibold">
                    {Object.values(report.by_model).reduce((s, m) => s + m.task_count, 0)}
                  </td>
                  <td className="pt-2 text-right text-gray-200 font-semibold">${costEstimate.toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
