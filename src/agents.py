"""Centralized agent registry — single source of truth for agent metadata.

All modules that need agent names, teams, or models should import from here
instead of maintaining their own copies.
"""

AGENT_REGISTRY: dict[str, dict] = {
    "ceo":               {"name": "Marcus",   "role": "CEO — Central Orchestrator",           "team": "leadership",  "model": "opus",   "provider": "anthropic", "status": "permanent"},
    "cto":               {"name": "Elena",    "role": "Chief Technology Officer",             "team": "leadership",  "model": "opus",   "provider": "anthropic", "status": "permanent"},
    "chief-researcher":  {"name": "Victor",   "role": "Chief Researcher",                     "team": "leadership",  "model": "opus",   "provider": "anthropic", "status": "permanent"},
    "ciso":              {"name": "Rachel",   "role": "Chief Information Security Officer",   "team": "leadership",  "model": "opus",   "provider": "anthropic", "status": "permanent"},
    "cfo":               {"name": "Jonathan", "role": "Chief Financial Officer",              "team": "leadership",  "model": "sonnet", "provider": "anthropic", "status": "permanent"},
    "vp-product":        {"name": "Sarah",    "role": "VP of Product",                        "team": "leadership",  "model": "sonnet", "provider": "anthropic", "status": "permanent"},
    "vp-engineering":    {"name": "David",    "role": "VP of Engineering",                    "team": "leadership",  "model": "sonnet", "provider": "anthropic", "status": "permanent"},
    "lead-backend":      {"name": "James",    "role": "Lead Backend Engineer",                "team": "engineering", "model": "sonnet", "provider": "anthropic", "status": "permanent"},
    "lead-frontend":     {"name": "Priya",    "role": "Lead Frontend Engineer",               "team": "engineering", "model": "sonnet", "provider": "anthropic", "status": "permanent"},
    "lead-designer":     {"name": "Lena",     "role": "Lead UI/UX Designer",                  "team": "design",      "model": "sonnet", "provider": "anthropic", "status": "permanent"},
    "qa-lead":           {"name": "Carlos",   "role": "QA Lead",                              "team": "engineering", "model": "sonnet", "provider": "anthropic", "status": "permanent"},
    "devops":            {"name": "Nina",     "role": "DevOps Engineer",                      "team": "engineering", "model": "sonnet", "provider": "anthropic", "status": "permanent"},
    "security-engineer": {"name": "Alex",     "role": "Security Engineer",                    "team": "on_demand",   "model": "opus",   "provider": "anthropic", "status": "available"},
    "data-engineer":     {"name": "Maya",     "role": "Data Engineer",                        "team": "on_demand",   "model": "sonnet", "provider": "anthropic", "status": "available"},
    "tech-writer":       {"name": "Tom",      "role": "Technical Writer",                     "team": "on_demand",   "model": "sonnet", "provider": "anthropic", "status": "available"},
}


def get_agent_display_name(slug: str) -> str:
    """Return the human-readable display name for an agent slug."""
    info = AGENT_REGISTRY.get(slug)
    if info:
        return info["name"]
    return slug.replace("-", " ").title()


def get_all_agent_ids() -> list[str]:
    """Return all known agent IDs."""
    return list(AGENT_REGISTRY.keys())


def is_core_agent(slug: str) -> bool:
    """Return True if the agent is a permanent or on-demand team member."""
    return slug in AGENT_REGISTRY
