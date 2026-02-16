import type { Agent } from '../types';

interface OrgChartProps {
  agents: Agent[];
  loading: boolean;
}

function modelBadge(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'bg-violet-900 text-violet-300 border-violet-700';
  if (lower.includes('sonnet')) return 'bg-blue-900 text-blue-300 border-blue-700';
  if (lower.includes('haiku')) return 'bg-green-900 text-green-300 border-green-700';
  return 'bg-gray-800 text-gray-300 border-gray-600';
}

function modelShortName(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'Opus';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('haiku')) return 'Haiku';
  return model;
}

function statusDot(status: string): string {
  switch (status?.toLowerCase()) {
    case 'active': return 'bg-green-400';
    case 'idle': return 'bg-yellow-400';
    case 'busy': return 'bg-orange-400';
    default: return 'bg-gray-500';
  }
}

function AgentCard({ agent }: { agent: Agent }) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 flex flex-col gap-3 hover:border-violet-600 transition-colors duration-150">
      {/* Avatar + name */}
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-violet-800 flex items-center justify-center flex-shrink-0 text-sm font-bold text-violet-200">
          {agent.name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${statusDot(agent.status)}`}
              aria-label={`Status: ${agent.status}`}
            />
            <h3 className="text-sm font-semibold text-white truncate">{agent.name}</h3>
          </div>
          <p className="text-xs text-gray-400 mt-0.5 truncate">{agent.role}</p>
        </div>
      </div>

      {/* Badges */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${modelBadge(agent.model)}`}>
          {modelShortName(agent.model)}
        </span>
        {agent.team && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-300 border border-gray-600">
            {agent.team}
          </span>
        )}
      </div>
    </div>
  );
}

function RowSection({ label, agents }: { label: string; agents: Agent[] }) {
  if (agents.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">{label}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {agents.map((agent) => (
          <AgentCard key={agent.id ?? agent.name} agent={agent} />
        ))}
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 animate-pulse">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-gray-700" />
        <div className="flex-1 space-y-2">
          <div className="h-3 bg-gray-700 rounded w-3/4" />
          <div className="h-2.5 bg-gray-700 rounded w-1/2" />
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <div className="h-5 w-14 bg-gray-700 rounded-full" />
        <div className="h-5 w-16 bg-gray-700 rounded-full" />
      </div>
    </div>
  );
}

export default function OrgChart({ agents, loading }: OrgChartProps) {
  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-500 text-sm">
        No agents found. Is the CrackPie backend running?
      </div>
    );
  }

  // Bucket agents by team field first (from API), fall back to role keywords
  const ceo = agents.filter((a) => a.team === 'executive' || /ceo|chief executive|president/i.test(a.role));
  const leadership = agents.filter(
    (a) =>
      !ceo.includes(a) &&
      (a.team === 'leadership' || (
        /cto|cfo|coo|vp |director|head of|chief (?!executive)/i.test(a.role) &&
        !/ceo|chief executive|president/i.test(a.role)
      ))
  );
  const engineering = agents.filter(
    (a) =>
      !ceo.includes(a) && !leadership.includes(a) &&
      (a.team === 'engineering' || a.team === 'design' ||
        /engineer|developer|dev |architect|sre|qa|test|ops|backend|frontend|full.?stack|designer/i.test(a.role))
  );
  const onDemand = agents.filter(
    (a) =>
      !ceo.includes(a) && !leadership.includes(a) && !engineering.includes(a)
  );

  return (
    <div className="space-y-8" aria-label="Organization chart">
      {ceo.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Chief Executive</h3>
          <div className="flex justify-start">
            <div className="w-full sm:w-64">
              <AgentCard agent={ceo[0]} />
            </div>
          </div>
        </div>
      )}
      <RowSection label="Leadership" agents={leadership} />
      <RowSection label="Engineering" agents={engineering} />
      <RowSection label="On-Demand / Specialist" agents={onDemand} />
    </div>
  );
}
