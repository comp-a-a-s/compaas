import type { Agent, Project, Task, TokenReport } from '../types';

const BASE = '/api';

export async function fetchOrgChart(): Promise<Agent[]> {
  const res = await fetch(`${BASE}/agents`);
  return res.json();
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${BASE}/projects`);
  return res.json();
}

export async function fetchProjectDetail(id: string): Promise<{ project: Project; tasks: Task[] }> {
  const res = await fetch(`${BASE}/projects/${id}`);
  return res.json();
}

export async function fetchTokenReport(): Promise<TokenReport | null> {
  const res = await fetch(`${BASE}/metrics/tokens`);
  if (!res.ok) return null;
  return res.json();
}

export function createActivityStream(onMessage: (line: string) => void): EventSource {
  const es = new EventSource(`${BASE}/activity/stream`);
  es.onmessage = (e) => onMessage(e.data);
  return es;
}
