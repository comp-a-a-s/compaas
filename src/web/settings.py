"""Runtime settings and feature flags for the web API."""

from __future__ import annotations

from functools import lru_cache

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from src.utils import resolve_data_dir, resolve_project_root


class SandboxProfile(BaseModel):
    """Execution policy profile used to constrain tool/CLI execution."""

    max_commands: int = Field(default=40, ge=1)
    max_runtime_seconds: int = Field(default=900, ge=30)
    max_files_touched: int = Field(default=80, ge=1)


class FeatureFlags(BaseModel):
    """Incremental rollout toggles for advanced capabilities."""

    planning_approval_gate: bool = True
    structured_ceo_response: bool = True
    explain_delegation: bool = True
    no_delegation_mode: bool = True
    execution_intent_classifier: bool = True
    run_replay: bool = True
    memory_scopes: bool = True
    memory_retention: bool = True
    auto_chat_summarization: bool = True
    prompt_injection_guard: bool = True
    tool_budget_guardrails: bool = True
    diff_summary: bool = True
    github_advanced_controls: bool = True
    vercel_deploy_lifecycle: bool = True
    org_chart_advanced_layouts: bool = True
    ui_global_search: bool = True
    onboarding_tours: bool = True
    run_progress_drawer: bool = True
    run_watchdog: bool = True
    preview_review_layer: bool = True
    context_packs: bool = True
    stripe_billing_pack: bool = True


class RuntimeSettings(BaseSettings):
    """Typed environment-backed runtime settings."""

    model_config = SettingsConfigDict(env_prefix="COMPAAS_", extra="ignore")

    data_dir: str = Field(default_factory=resolve_data_dir)
    project_root: str = Field(default_factory=resolve_project_root)
    workspace_root: str = ""

    api_version_prefix: str = "/api/v1"
    max_project_concurrency: int = Field(default=1, ge=1, le=8)
    chat_auto_summary_interval: int = Field(default=18, ge=4, le=500)
    duplicate_turn_window_seconds: int = Field(default=300, ge=30, le=86400)

    safe_profile: SandboxProfile = Field(
        default_factory=lambda: SandboxProfile(max_commands=12, max_runtime_seconds=300, max_files_touched=20)
    )
    standard_profile: SandboxProfile = Field(
        default_factory=lambda: SandboxProfile(max_commands=40, max_runtime_seconds=900, max_files_touched=80)
    )
    full_profile: SandboxProfile = Field(
        default_factory=lambda: SandboxProfile(max_commands=120, max_runtime_seconds=1800, max_files_touched=300)
    )

    feature_flags: FeatureFlags = Field(default_factory=FeatureFlags)

    def resolved_workspace_root(self) -> str:
        if self.workspace_root.strip():
            return self.workspace_root.strip()
        return f"{self.project_root}/projects"


@lru_cache(maxsize=1)
def get_runtime_settings() -> RuntimeSettings:
    return RuntimeSettings()


def merge_feature_flags(config: dict, defaults: FeatureFlags | None = None) -> FeatureFlags:
    """Merge config-level feature flags over runtime defaults."""
    merged = (defaults or get_runtime_settings().feature_flags).model_copy(deep=True)
    cfg_flags = config.get("feature_flags", {}) if isinstance(config, dict) else {}
    if not isinstance(cfg_flags, dict):
        return merged
    for key, value in cfg_flags.items():
        if hasattr(merged, key):
            try:
                setattr(merged, key, bool(value))
            except Exception:
                continue
    return merged


def resolve_sandbox_profile(name: str) -> SandboxProfile:
    settings = get_runtime_settings()
    normalized = (name or "standard").strip().lower()
    if normalized == "safe":
        return settings.safe_profile
    if normalized == "full":
        return settings.full_profile
    return settings.standard_profile
