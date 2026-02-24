# Plan: Rewrite All 15 Crew Member System Prompts + Dynamic Templating

## Overview

Full rewrite of all 15 `.claude/agents/*.md` system prompts with:
- **Dynamic names** via a templating system (no more hardcoded "CrackPie" / "Idan")
- **Concise prompts** — target <150 lines each, trim bloat, keep only impactful instructions
- **Consistent structure** across all agents
- **Stronger identity** and clearer role boundaries

---

## Part 1: Templating System

### Problem
All 15 agent files hardcode `CrackPie` as company name and `Idan` as Board Head. When a user configures different names in `company_data/config.yaml`, the agent prompts still reference the old names.

### Solution
1. **Create template files**: `.claude/agent-templates/{name}.md` — identical to current `.md` files but with `{{COMPANY_NAME}}`, `{{BOARD_HEAD}}`, and `{{AGENT_NAME_*}}` placeholders
2. **Create render script**: `scripts/render_agents.py` — reads config from `company_data/config.yaml`, substitutes placeholders, writes to `.claude/agents/*.md`
3. **Hook into startup**: Call `render_agents.py` at web server startup (in `src/web/main.py`)
4. **Hook into config save**: Call `render_agents.py` after `_save_config()` in `src/web/api.py`

### Template Variables
| Placeholder | Source in config.yaml | Default |
|---|---|---|
| `{{COMPANY_NAME}}` | `company.name` | `COMPaaS` |
| `{{BOARD_HEAD}}` | `user.name` | `User` |
| `{{CEO_NAME}}` | `agents.ceo` | `Marcus` |
| `{{CTO_NAME}}` | `agents.cto` | `Elena` |
| `{{RESEARCHER_NAME}}` | `agents.chief-researcher` | `Victor` |
| `{{CISO_NAME}}` | `agents.ciso` | `Rachel` |
| `{{CFO_NAME}}` | `agents.cfo` | `Jonathan` |
| `{{VP_PRODUCT_NAME}}` | `agents.vp-product` | `Sarah` |
| `{{VP_ENG_NAME}}` | `agents.vp-engineering` | `David` |
| `{{BACKEND_NAME}}` | `agents.lead-backend` | `James` |
| `{{FRONTEND_NAME}}` | `agents.lead-frontend` | `Priya` |
| `{{DESIGNER_NAME}}` | `agents.lead-designer` | `Lena` |
| `{{QA_NAME}}` | `agents.qa-lead` | `Carlos` |
| `{{DEVOPS_NAME}}` | `agents.devops` | `Nina` |
| `{{SECURITY_NAME}}` | `agents.security-engineer` | `Alex` |
| `{{DATA_NAME}}` | `agents.data-engineer` | `Maya` |
| `{{WRITER_NAME}}` | `agents.tech-writer` | `Tom` |

### Implementation: `scripts/render_agents.py`
```python
"""Render agent templates with dynamic names from config."""
import os, re, yaml

TEMPLATE_DIR = ".claude/agent-templates"
OUTPUT_DIR = ".claude/agents"
CONFIG_PATH = "company_data/config.yaml"
DEFAULTS = { ... }  # all defaults from table above

def load_config():
    if not os.path.exists(CONFIG_PATH):
        return {}
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f) or {}

def get_variables(config):
    """Build template variable dict from config with fallbacks."""
    agents = config.get("agents", {})
    return {
        "COMPANY_NAME": config.get("company", {}).get("name", "") or "COMPaaS",
        "BOARD_HEAD": config.get("user", {}).get("name", "") or "User",
        "CEO_NAME": agents.get("ceo", "Marcus"),
        # ... all other agent names
    }

def render_templates():
    config = load_config()
    variables = get_variables(config)
    for template_file in os.listdir(TEMPLATE_DIR):
        if not template_file.endswith(".md"):
            continue
        with open(os.path.join(TEMPLATE_DIR, template_file)) as f:
            content = f.read()
        for key, value in variables.items():
            content = content.replace(f"{{{{{key}}}}}", value)
        with open(os.path.join(OUTPUT_DIR, template_file), "w") as f:
            f.write(content)
```

### Integration Points
1. `src/web/main.py` — call `render_templates()` at startup before `uvicorn.run()`
2. `src/web/api.py` — call `render_templates()` at end of `_save_config()` and `setup_config()`
3. Keep `.claude/agents/*.md` in `.gitignore` (generated files). Track `.claude/agent-templates/*.md` in git.

---

## Part 2: Prompt Design Principles (Applied to All 15)

### Structure Template (every agent follows this)
```markdown
---
(frontmatter: name, description, tools, model)
---

# {Name} — {Role} at {{COMPANY_NAME}}

You are **{Name}**, the **{Role}** at **{{COMPANY_NAME}}**. {{BOARD_HEAD}} is the Board Head.

## Role
2-3 sentences defining the agent's core mission and what makes them distinctive.

## Responsibilities
Numbered list, 4-7 items. Specific, not generic.

## How You Work
Bullet list of concrete behaviors and methods. No fluff.

## [Domain-Specific Section(s)]
1-2 sections with the most impactful domain knowledge. Tables, templates, and examples.

## Coordination
Who this agent works with and how handoffs happen.

## Output
Where to write files and what format to use.

## Rules
3-5 critical rules including file writing rules.
```

### Key Design Decisions
1. **No redundant "expertise" preambles** — Remove generic "world-class", "15+ years" fluff. The model already knows it's playing a role.
2. **Merge "How You Work" and "Standards"** — Currently separate in many prompts; combine into one focused section.
3. **Remove code examples from non-coding agents** — CTO, CISO, VP Product etc. don't need TypeScript/Python examples. They produce specs, not code.
4. **Remove duplicate content across agents** — E.g., the file writing rule is ~4 lines in every prompt. Reduce to 1 line.
5. **Add coordination sections** — Every agent knows who they hand off to and who they receive from.
6. **Cut verbose frameworks** — Keep only the ones agents actually use. Remove "nice to have" reference material.

---

## Part 3: Per-Agent Prompt Design

### 1. CEO (Marcus) — `ceo.md` — Target: ~140 lines

**Current**: 215 lines. Very thorough but verbose.

**What to keep** (high impact):
- Team roster with names and roles (essential for delegation)
- Output directory rules (prevents critical file path errors)
- Wave-based execution workflow (core operational pattern)
- Quality gates table (prevents premature advancement)
- Escalation protocol (handles blockers)
- Handoff protocol (ensures clean transitions)

**What to cut** (low impact per token):
- Rollback procedure (6-step process rarely triggered; CEO delegates this to DevOps)
- Cross-project resource scheduling (edge case; can be handled ad-hoc)
- Architecture review protocol (this is CTO + CISO's job; CEO just delegates)
- Micro-agent section (the MCP tool description handles this)
- "Critical Rules" section at the bottom (redundant with inline rules)

**What to add**:
- First-contact protocol: what to do when the user first opens the app
- Ambiguity resolution: when the user's intent is unclear, ask instead of assuming

**Key changes**:
- Consolidate "How You Operate" subsections into a single workflow
- Move detailed protocols to be referenced by name rather than spelled out
- Tighten the language throughout

---

### 2. CTO (Elena) — `cto.md` — Target: ~120 lines

**Current**: 192 lines. Excellent content but heavy on reference material.

**What to keep**:
- Technology Evaluation Framework (scoring table — very actionable)
- ADR template (defines the output format; essential)
- Scalability assessment (CAP theorem, horizontal vs vertical)
- Cross-agent coordination (Rachel, Jonathan, David)
- Performance benchmarking SLO template

**What to cut**:
- Technology Radar section (nice but never meaningfully used in practice)
- API versioning strategy (this belongs in lead-backend's prompt, not CTO's)
- Technical debt quadrant table (VP Engineering manages debt backlog)
- Verbose "How You Work" section (5 bullets can become 3)

**What to add**:
- Build vs buy decision framework (1-2 lines, currently missing)
- When to recommend monolith vs microservices (common decision)

---

### 3. Chief Researcher (Victor) — `chief-researcher.md` — Target: ~100 lines

**Current**: 128 lines. Well-structured but has some redundancy.

**What to keep**:
- Multi-source triangulation methodology
- Confidence levels (High/Medium/Low)
- Facts vs Analysis distinction
- Output format (Executive Summary → Key Findings → Detailed Analysis → Sources)
- Source citation requirements

**What to cut**:
- Exhaustive list of all 5 core competencies with sub-bullets (too granular; the researcher knows how to research)
- "Recommendations for Further Research" section definition (obvious)
- "Boundaries and Role Clarity" section (1 sentence suffices)

**What to add**:
- Research speed calibration: when CEO asks for "quick scan" vs "deep dive", adjust depth
- Structured output templates for the 3 most common requests: market sizing, competitive analysis, technology landscape

---

### 4. CISO (Rachel) — `ciso.md` — Target: ~110 lines

**Current**: 154 lines. Strong, specific, good examples.

**What to keep**:
- Role distinction table (Rachel vs Alex) — critical for correct delegation
- "Specific and Implementable" output standard with good/bad examples
- Core competencies (but trimmed to 3 key areas)
- Output formats for ADRs, risk registers, security requirements
- Guiding principles (5 principles, 1 line each)

**What to cut**:
- Vendor Security subsection (edge case; can be handled ad-hoc)
- Compliance Strategy subsection (too detailed for a system prompt; she'll research compliance frameworks when needed)
- "Security Policy" subsection (overlaps with auth architecture)

**What to add**:
- OWASP Top 10 quick-reference (one line per category with the key mitigation)
- Coordination protocol with Alex (when Rachel hands off to Alex for code audit)

---

### 5. CFO (Jonathan) — `cfo.md` — Target: ~110 lines

**Current**: 191 lines. Very detailed but much is reference material.

**What to keep**:
- "Quality is Non-Negotiable" absolute rule (essential guardrail)
- Financial Viability Assessment framework (TAM/SAM/SOM, unit economics)
- Go/No-Go recommendation format
- Token Economy responsibilities (budget estimation, usage analysis)
- Cost-Quality trade-off table format

**What to cut**:
- Verbose financial model table template (he'll produce the right format when needed)
- Token Economy report template (overly prescriptive formatting)
- Build vs Buy detailed sub-bullets (CTO handles the technical side)
- "Guiding Principles" (5 lines of philosophy that don't change behavior)

**What to add**:
- Quick-estimate mode: when CEO asks for a "rough number", provide fast 80/20 estimates
- Competitive pricing benchmark methodology (1-2 lines)

---

### 6. VP Product (Sarah) — `vp-product.md` — Target: ~130 lines

**Current**: 43 lines. THE WEAKEST prompt. Critically underspecified.

**What to keep**:
- RICE framework mention
- User story format

**What to add (major expansion)**:
- **PRD template** — structured sections: Problem Statement, Target Users, User Personas (template), User Stories with acceptance criteria, Success Metrics (HEART framework), Scope (in/out), Dependencies, Risks
- **Prioritization framework** — RICE scoring with a concrete example
- **MVP definition process** — how to scope down from full vision to minimum viable
- **Competitive analysis format** — feature matrix template
- **Success metrics framework** — HEART (Happiness, Engagement, Adoption, Retention, Task success) with example KPIs per dimension
- **Cross-agent coordination** — handoff to CTO for feasibility, to VP Eng for estimation, to CFO for viability, to Designer for UX
- **Product discovery process** — problem framing → solution ideation → prioritization → specification

---

### 7. VP Engineering (David) — `vp-engineering.md` — Target: ~120 lines

**Current**: 170 lines. Very thorough but heavy on process documentation.

**What to keep**:
- Sprint planning methodology (task breakdown, dependency graph)
- Definition of Done checklist (code quality, testing, security, docs, deployment)
- Code review standards (automated + human review checklist)
- Velocity tracking metrics
- Technical debt 20% budget rule

**What to cut**:
- Retrospective framework (too process-heavy for a system prompt; David knows how to run retros)
- PR size guidelines (nice but low-impact)
- Review SLA section (operational detail that doesn't affect prompt behavior)
- "Anti-patterns to Avoid" list for retros (meta-advice about retros)

**What to add**:
- Incident severity classification (P0-P3 with response expectations)
- Resource allocation heuristic (which agent for which task type)

---

### 8. Lead Backend (James) — `lead-backend.md` — Target: ~100 lines

**Current**: 122 lines. Good content, well-balanced.

**What to keep**:
- API versioning strategy (URL versioning, breaking change rules)
- Rate limiting implementation spec
- Auth integration rules (JWT validation, IDOR protection)
- Health check endpoints (`/health/live`, `/health/ready`)
- Structured logging requirements

**What to cut**:
- Circuit breaker detailed spec (operational concern; DevOps handles this)
- Request tracing full W3C spec (DevOps + infra concern)
- Monitoring subsection headers (structured logging + health checks suffice)

**What to add**:
- Database migration safety rules (always reversible, expand-contract for destructive changes)
- Pagination pattern (cursor-based for large datasets, offset-based for simple cases)
- Coordination with Priya (API contract freeze, shared types)

---

### 9. Lead Frontend (Priya) — `lead-frontend.md` — Target: ~100 lines

**Current**: 192 lines. Very long due to code examples.

**What to keep**:
- State management decision rule (when to use what)
- Performance targets table (Core Web Vitals)
- Form handling approach (React Hook Form + Zod)
- Error boundary placement strategy
- Accessibility requirements

**What to cut**:
- All code examples (Zustand store, RTK Query, form component, error boundary component) — these are reference material that bloats the prompt. The model already knows React patterns.
- "Performance Implementation Checklist" (8 checkboxes of generic React performance advice)
- Detailed error boundary component implementation code

**What to add**:
- Testing strategy (what to test: user interactions via Testing Library, not implementation details)
- Coordination with Lena (receive design specs) and James (consume API contracts)
- Internationalization mention (i18n-ready from day 1 if project requires it)

---

### 10. Lead Designer (Lena) — `lead-designer.md` — Target: ~120 lines

**Current**: 48 lines. SECOND WEAKEST prompt. Severely underspecified.

**What to keep**:
- Design system first approach
- Component spec structure (name, purpose, props, variants, states, responsive, a11y)
- Design principles (5 items)

**What to add (major expansion)**:
- **Design token system** — define the categories: colors (semantic tokens: primary, secondary, error, warning, success, neutral + shades), typography (scale: xs through 2xl with font weights), spacing (4px grid: 0.5, 1, 2, 3, 4, 6, 8, 12, 16), border radius, shadows, breakpoints
- **Component spec template** — structured YAML-like format with all states, responsive behavior, and accessibility annotations
- **User flow diagram format** — numbered steps with decision points, error paths, and success criteria
- **Accessibility requirements** — WCAG 2.1 AA: contrast ratios (4.5:1 normal text, 3:1 large text), focus management, keyboard navigation, screen reader annotations
- **Responsive breakpoints** — mobile (375px), tablet (768px), desktop (1024px), wide (1440px)
- **Handoff to frontend** — what Priya needs from Lena: token values, component specs, interaction descriptions, responsive behavior
- **Design review checklist** — consistency, accessibility, responsiveness, states coverage

---

### 11. QA Lead (Carlos) — `qa-lead.md` — Target: ~110 lines

**Current**: 175 lines. Very thorough but verbose on testing tool configs.

**What to keep**:
- Test pyramid principle (many unit, fewer integration, minimal e2e)
- Bug report format
- Accessibility testing (axe-core, Lighthouse score ≥90)
- Performance testing approach (baseline, spike, soak)
- Security testing (OWASP ZAP, manual spot checks)
- Test environment requirements

**What to cut**:
- k6 code example (the model knows k6)
- Core Web Vitals table (duplicate — same table appears in Priya's prompt)
- Visual regression testing section (nice but low priority; can be ad-hoc)
- Detailed "Manual Accessibility Checks" subsection (axe-core covers most)
- "Test Isolation" subsection (obvious testing practice)

**What to add**:
- Test data management strategy (seed scripts, factories, not manual records)
- Coverage targets by module type (critical path ≥90%, utilities ≥80%, UI ≥70%)
- Coordination: receives code from James/Priya, reports bugs back, signs off for wave advancement

---

### 12. DevOps (Nina) — `devops.md` — Target: ~110 lines

**Current**: 187 lines. Very comprehensive but heavy on ops runbooks.

**What to keep**:
- Multi-stage Docker builds, minimal base images, non-root
- CI/CD pipeline structure (PR checks vs deployment)
- Multi-environment strategy table (dev/staging/prod)
- Security scanning in CI (SAST, dependency audit, container scan, secret detection)
- Rollback decision tree

**What to cut**:
- Full observability stack (3 subsections on logging/metrics/tracing — this is reference material)
- Rollback procedures step-by-step (the decision tree suffices; Nina knows how to roll back)
- Database migration rollback details (James owns migrations)
- Disaster recovery RTO/RPO tables (operational planning done at project start, not per-task)
- DR Runbook template (too detailed for a system prompt)
- Backup verification (can be specified ad-hoc)

**What to add**:
- GitHub Actions workflow template reference (since that's the default CI)
- Coordination with James (migrations in CI), Carlos (test environments), Rachel (security scanning config)

---

### 13. Security Engineer (Alex) — `security-engineer.md` — Target: ~120 lines

**Current**: 49 lines. THIRD WEAKEST prompt. Needs major expansion.

**What to keep**:
- OWASP Top 10 systematic review approach
- Finding report format (severity, category, location, impact, recommendation)
- Distinction from CISO (receives strategic direction from Rachel, does tactical review)

**What to add (major expansion)**:
- **OWASP Top 10 review checklist** — for each category, 2-3 specific code patterns to look for:
  - A01 Broken Access Control: IDOR, missing auth checks, path traversal
  - A02 Cryptographic Failures: weak algorithms, hardcoded keys, missing TLS
  - A03 Injection: SQL injection, command injection, LDAP injection, XSS
  - A04 Insecure Design: missing rate limiting, no threat model
  - A05 Security Misconfiguration: default credentials, verbose errors, unnecessary features
  - A06 Vulnerable Components: outdated dependencies, known CVEs
  - A07 Auth Failures: weak passwords, session fixation, credential stuffing
  - A08 Data Integrity Failures: deserialization, unsigned updates
  - A09 Logging Failures: missing auth event logs, PII in logs
  - A10 SSRF: unvalidated URLs, internal network access
- **Dependency scanning methodology** — `pip-audit`, `npm audit`, `govulncheck`; severity classification
- **Auth review checklist** — JWT validation, session management, password storage, MFA, IDOR
- **Severity classification criteria** — Critical (RCE, auth bypass, data breach) / High (privilege escalation, XSS, CSRF) / Medium (info disclosure, weak config) / Low (best practice improvements)
- **Coordination**: receives security requirements from Rachel, reports findings to CEO, works with James/Priya on remediation

---

### 14. Data Engineer (Maya) — `data-engineer.md` — Target: ~100 lines

**Current**: 181 lines. Very thorough but heavy on reference tables.

**What to keep**:
- Data modeling pattern selection (Star Schema / Data Vault / 3NF — when to use which)
- Data quality framework (4 dimensions table)
- PII handling rules (coordinate with Rachel)
- Query optimization approach (EXPLAIN ANALYZE, index strategy)
- Migration safety (always reversible)

**What to cut**:
- Modern data stack full component list (Maya knows dbt/Airflow/Kafka)
- Pipeline monitoring SLA template (operational detail)
- Schema drift detection subsection (obvious data engineering practice)
- Backup and DR full section (DevOps owns infrastructure DR)
- Data classification table (duplicate — same table in CISO prompt)
- Data lineage documentation requirements (obvious)
- Partitioning strategy details (standard knowledge)

**What to add**:
- Real-time vs batch decision criteria (when to use streaming vs scheduled)
- Coordination: works with James on application DB schema, with Rachel on PII classification

---

### 15. Tech Writer (Tom) — `tech-writer.md` — Target: ~90 lines

**Current**: 150 lines. Good structure but heavy on examples.

**What to keep**:
- Divio documentation framework (tutorials, how-to, reference, explanation)
- OpenAPI spec requirement for REST APIs
- Documentation quality checklist
- Information architecture (`/docs` directory structure)
- Docs-as-code versioning strategy
- Changelog format (Keep a Changelog)

**What to cut**:
- OpenAPI YAML example (Tom knows OpenAPI)
- GraphQL documentation subsection (edge case)
- Verbose changelog format example (Tom knows Keep a Changelog)
- Information architecture full directory tree (the concept suffices, specific paths are project-dependent)

**What to add**:
- README template structure (one-paragraph summary, badges, quickstart, install, usage, config, contributing)
- Coordination: reads code from James/Priya, reads specs from Sarah/Elena, gets review from Carlos

---

## Part 4: Implementation Steps

### Step 1: Create the templating infrastructure
1. Create `scripts/render_agents.py` with template rendering logic
2. Create `.claude/agent-templates/` directory
3. Move current `.claude/agents/*.md` to `.claude/agent-templates/*.md` as starting point
4. Replace all hardcoded names with `{{PLACEHOLDER}}` variables
5. Add `render_agents()` call to `src/web/main.py` startup
6. Add `render_agents()` call to `_save_config()` in `src/web/api.py`
7. Add `.claude/agents/*.md` to `.gitignore` (generated files — but keep the CEO for now since it's used by the outer CLI too)

### Step 2: Rewrite all 15 prompts (in template form)
Order of implementation:
1. **VP Product** (Sarah) — biggest gap, most new content
2. **Lead Designer** (Lena) — second biggest gap
3. **Security Engineer** (Alex) — third biggest gap
4. **CEO** (Marcus) — anchor prompt, sets the tone
5. **CTO** (Elena) — high-impact leadership
6. **CISO** (Rachel) — security strategy
7. **CFO** (Jonathan) — financial analysis
8. **VP Engineering** (David) — engineering process
9. **Lead Backend** (James) — primary code producer
10. **Lead Frontend** (Priya) — primary UI producer
11. **QA Lead** (Carlos) — quality gate keeper
12. **DevOps** (Nina) — infrastructure
13. **Chief Researcher** (Victor) — research
14. **Data Engineer** (Maya) — data specialist
15. **Tech Writer** (Tom) — documentation

### Step 3: Test and verify
1. Run `scripts/render_agents.py` to verify template rendering
2. Verify all placeholders are substituted correctly
3. Check that the web server starts successfully
4. Verify config changes trigger re-rendering

---

## Summary of Changes

| Agent | Current Lines | Target Lines | Change Type |
|---|---|---|---|
| CEO (Marcus) | 215 | ~140 | Trim + restructure |
| CTO (Elena) | 192 | ~120 | Trim + focus |
| Chief Researcher (Victor) | 128 | ~100 | Trim |
| CISO (Rachel) | 154 | ~110 | Trim + refocus |
| CFO (Jonathan) | 191 | ~110 | Heavy trim |
| VP Product (Sarah) | 43 | ~130 | **Major expansion** |
| VP Engineering (David) | 170 | ~120 | Trim |
| Lead Backend (James) | 122 | ~100 | Minor trim + adds |
| Lead Frontend (Priya) | 192 | ~100 | Heavy trim (remove code examples) |
| Lead Designer (Lena) | 48 | ~120 | **Major expansion** |
| QA Lead (Carlos) | 175 | ~110 | Trim |
| DevOps (Nina) | 187 | ~110 | Heavy trim |
| Security Engineer (Alex) | 49 | ~120 | **Major expansion** |
| Data Engineer (Maya) | 181 | ~100 | Heavy trim |
| Tech Writer (Tom) | 150 | ~90 | Trim |
| **Total** | **2297** | **~1680** | **-27% total, +quality** |

### New Files Created
- `scripts/render_agents.py` — template renderer
- `.claude/agent-templates/*.md` — 15 template files (source of truth)

### Files Modified
- `src/web/main.py` — add `render_agents()` call at startup
- `src/web/api.py` — add `render_agents()` call after config save
- `.gitignore` — add `.claude/agents/*.md` as generated files
