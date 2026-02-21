"""Service helpers for GitHub and Vercel integration workflows."""

from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class IntegrationService:
    """Best-effort integration actions for GitHub/Vercel workflows."""

    def __init__(self, data_dir: str):
        self.data_dir = data_dir

    @staticmethod
    def _github_request(token: str, method: str, path: str, payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
        url = f"https://api.github.com{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            method=method.upper(),
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "Content-Type": "application/json",
                "User-Agent": "COMPaaS",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                status = resp.getcode()
                body = resp.read().decode("utf-8")
                return status, json.loads(body) if body else {}
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(body) if body else {}
            except json.JSONDecodeError:
                parsed = {"message": body}
            return exc.code, parsed
        except Exception as exc:
            return 0, {"message": str(exc)}

    @staticmethod
    def _run_git(repo_path: str, args: list[str]) -> tuple[bool, str]:
        try:
            out = subprocess.run(
                ["git", *args],
                cwd=repo_path,
                check=True,
                capture_output=True,
                text=True,
            )
            combined = (out.stdout or out.stderr or "").strip()
            return True, combined
        except subprocess.CalledProcessError as exc:
            msg = (exc.stdout or exc.stderr or str(exc)).strip()
            return False, msg
        except Exception as exc:
            return False, str(exc)

    def list_github_repos(self, token: str, per_page: int = 100) -> dict[str, Any]:
        status, body = self._github_request(token, "GET", f"/user/repos?per_page={per_page}&sort=updated")
        if status != 200:
            return {"status": "error", "http_status": status, "message": body.get("message", "Failed to list repos")}
        repos = []
        if isinstance(body, list):
            for repo in body:
                if not isinstance(repo, dict):
                    continue
                repos.append(
                    {
                        "full_name": repo.get("full_name", ""),
                        "private": bool(repo.get("private")),
                        "default_branch": repo.get("default_branch", "master"),
                        "permissions": repo.get("permissions", {}),
                    }
                )
        return {"status": "ok", "repos": repos}

    def create_github_repo(self, token: str, *, name: str, private: bool = True, description: str = "") -> dict[str, Any]:
        payload = {
            "name": name,
            "private": private,
            "description": description,
            "auto_init": True,
        }
        status, body = self._github_request(token, "POST", "/user/repos", payload)
        if status not in (201, 202):
            return {"status": "error", "http_status": status, "message": body.get("message", "Failed to create repo")}
        return {
            "status": "ok",
            "repo": {
                "full_name": body.get("full_name", ""),
                "default_branch": body.get("default_branch", "master"),
                "html_url": body.get("html_url", ""),
                "clone_url": body.get("clone_url", ""),
            },
        }

    def create_branch(self, repo_path: str, *, base_branch: str, new_branch: str) -> dict[str, Any]:
        ok, out = self._run_git(repo_path, ["fetch", "origin", base_branch])
        if not ok:
            return {"status": "error", "message": out}
        ok, out = self._run_git(repo_path, ["checkout", "-B", new_branch, f"origin/{base_branch}"])
        if not ok:
            return {"status": "error", "message": out}
        return {"status": "ok", "branch": new_branch, "message": out}

    def infer_change_type_label(self, summary: str) -> str:
        text = (summary or "").lower()
        if any(token in text for token in ("fix", "bug", "error", "crash", "regression")):
            return "fix"
        if any(token in text for token in ("docs", "readme", "documentation")):
            return "docs"
        if any(token in text for token in ("chore", "refactor", "cleanup", "lint")):
            return "chore"
        return "feat"

    def build_pr_template(self, *, title: str, summary: str, run_id: str, provider: str) -> str:
        return (
            f"## Summary\n{summary.strip() or '-'}\n\n"
            "## Pipeline Stages\n"
            "- [x] Plan\n"
            "- [x] Build\n"
            "- [x] Test\n"
            "- [ ] Deploy\n\n"
            "## AI Run Metadata\n"
            f"- Run ID: `{run_id}`\n"
            f"- Provider: `{provider}`\n"
            f"- Created At: `{_utcnow_iso()}`\n\n"
            "## Validation\n"
            "- [ ] Unit tests passed\n"
            "- [ ] Manual QA completed\n"
            "- [ ] Rollback path documented\n"
        )

    def pre_push_secret_scan(self, repo_path: str) -> dict[str, Any]:
        patterns = {
            "OpenAI API key": re.compile(r"sk-[a-zA-Z0-9_-]{20,}"),
            "GitHub token": re.compile(r"ghp_[a-zA-Z0-9]{20,}"),
            "AWS Access Key": re.compile(r"AKIA[0-9A-Z]{16}"),
            "Private key": re.compile(r"-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----"),
        }
        findings: list[dict[str, Any]] = []
        for root, _, files in os.walk(repo_path):
            if ".git" in root.split(os.sep):
                continue
            for name in files:
                path = os.path.join(root, name)
                try:
                    with open(path, "r", encoding="utf-8", errors="ignore") as f:
                        text = f.read()
                except OSError:
                    continue
                for label, pattern in patterns.items():
                    for match in pattern.finditer(text):
                        findings.append(
                            {
                                "rule": label,
                                "file": os.path.relpath(path, repo_path),
                                "snippet": match.group(0)[:60],
                            }
                        )
                        if len(findings) >= 50:
                            break
                    if len(findings) >= 50:
                        break
        return {"status": "ok", "findings": findings, "clean": len(findings) == 0}

    def sync_remote(self, repo_path: str, default_branch: str = "master") -> dict[str, Any]:
        ok, fetch_out = self._run_git(repo_path, ["fetch", "--all", "--prune"])
        if not ok:
            return {"status": "error", "message": fetch_out}
        ok, status_out = self._run_git(repo_path, ["status", "--short", "--branch"])
        if not ok:
            return {"status": "error", "message": status_out}
        ok, rebase_out = self._run_git(repo_path, ["pull", "--rebase", "origin", default_branch])
        return {
            "status": "ok" if ok else "warning",
            "fetch": fetch_out,
            "status_output": status_out,
            "reconcile_output": rebase_out,
        }

    def detect_drift(self, repo_path: str, default_branch: str = "master") -> dict[str, Any]:
        ok, _ = self._run_git(repo_path, ["fetch", "origin", default_branch])
        if not ok:
            return {"status": "error", "message": "Failed to fetch origin state"}
        ok, out = self._run_git(repo_path, ["rev-list", "--left-right", "--count", f"HEAD...origin/{default_branch}"])
        if not ok:
            return {"status": "error", "message": out}
        parts = out.strip().split()
        ahead = int(parts[0]) if len(parts) > 0 and parts[0].isdigit() else 0
        behind = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
        return {"status": "ok", "ahead": ahead, "behind": behind, "drifted": ahead > 0 or behind > 0}

    def rollback_commit(self, repo_path: str, commit_sha: str) -> dict[str, Any]:
        ok, out = self._run_git(repo_path, ["revert", "--no-edit", commit_sha])
        if not ok:
            return {"status": "error", "message": out}
        return {"status": "ok", "message": out}

    @staticmethod
    def _vercel_request(
        token: str,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        url = f"https://api.vercel.com{path}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            method=method.upper(),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "User-Agent": "COMPaaS",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = resp.read().decode("utf-8")
                return resp.getcode(), json.loads(body) if body else {}
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(body) if body else {}
            except json.JSONDecodeError:
                parsed = {"message": body}
            return exc.code, parsed
        except Exception as exc:
            return 0, {"message": str(exc)}

    def vercel_link_project(self, token: str, *, name: str, team_id: str = "") -> dict[str, Any]:
        path = f"/v10/projects{f'?teamId={team_id}' if team_id else ''}"
        status, body = self._vercel_request(token, "POST", path, {"name": name})
        if status not in (200, 201):
            return {"status": "error", "http_status": status, "message": body.get("error", {}).get("message") or body.get("message", "Failed to link project")}
        return {"status": "ok", "project": body}

    def vercel_deploy(
        self,
        token: str,
        *,
        project_name: str,
        team_id: str = "",
        target: str = "preview",
        git_source: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        query = f"?teamId={team_id}" if team_id else ""
        payload: dict[str, Any] = {
            "name": project_name,
            "target": target,
        }
        if git_source:
            payload["gitSource"] = git_source
        status, body = self._vercel_request(token, "POST", f"/v13/deployments{query}", payload)
        if status not in (200, 201):
            return {"status": "error", "http_status": status, "message": body.get("error", {}).get("message") or body.get("message", "Failed to create deployment")}
        return {"status": "ok", "deployment": body}

    def vercel_assign_domain(
        self,
        token: str,
        *,
        project_name: str,
        domain: str,
        team_id: str = "",
    ) -> dict[str, Any]:
        query = f"?teamId={team_id}" if team_id else ""
        status, body = self._vercel_request(
            token,
            "POST",
            f"/v10/projects/{project_name}/domains{query}",
            {"name": domain},
        )
        if status not in (200, 201):
            return {"status": "error", "http_status": status, "message": body.get("error", {}).get("message") or body.get("message", "Failed to add domain")}
        return {"status": "ok", "domain": body}

    def vercel_set_env(
        self,
        token: str,
        *,
        project_name: str,
        key: str,
        value: str,
        target: list[str] | None = None,
        team_id: str = "",
    ) -> dict[str, Any]:
        query = f"?teamId={team_id}" if team_id else ""
        payload = {
            "key": key,
            "value": value,
            "type": "encrypted",
            "target": target or ["preview", "production"],
        }
        status, body = self._vercel_request(token, "POST", f"/v10/projects/{project_name}/env{query}", payload)
        if status not in (200, 201):
            return {"status": "error", "http_status": status, "message": body.get("error", {}).get("message") or body.get("message", "Failed to set environment variable")}
        return {"status": "ok", "result": body}

