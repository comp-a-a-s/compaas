import type { Agent, Project, Task, TokenReport } from '../types';

const BASE = '/api';

async function safeFetch<T>(url: string, fallback: T): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`API ${url} returned ${res.status}`);
    return fallback;
  }
  return res.json();
}

export async function fetchOrgChart(): Promise<Agent[]> {
  return safeFetch<Agent[]>(`${BASE}/agents`, []);
}

export async function fetchProjects(): Promise<Project[]> {
  return safeFetch<Project[]>(`${BASE}/projects`, []);
}

export async function fetchProjectDetail(id: string): Promise<{ project: Project; tasks: Task[] }> {
  const res = await fetch(`${BASE}/projects/${encodeURIComponent(id)}`);
  if (!res.ok) return { project: {} as Project, tasks: [] };
  return res.json();
}

export async function fetchTokenReport(): Promise<TokenReport | null> {
  return safeFetch<TokenReport | null>(`${BASE}/metrics/tokens`, null);
}

export function createActivityStream(onMessage: (line: string) => void): EventSource {
  const es = new EventSource(`${BASE}/activity/stream`);
  es.onmessage = (e) => onMessage(e.data);
  es.onerror = () => {
    // SSE reconnects automatically; suppress console noise
  };
  return es;
}
