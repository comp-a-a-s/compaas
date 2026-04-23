"""Service helpers for external connector workflows."""

from __future__ import annotations

import json
import os
import re
import ssl
import subprocess
import base64
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

try:
    import certifi
except Exception:  # pragma: no cover - optional dependency
    certifi = None


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class IntegrationService:
    """Best-effort integration actions for connector workflows."""

    def __init__(self, data_dir: str, workspace_root: str = ""):
        self.data_dir = data_dir
        self.workspace_root = os.path.realpath(str(workspace_root).strip()) if str(workspace_root).strip() else ""

    def _validate_repo_path(self, repo_path: str) -> tuple[bool, str, str]:
        """Validate a repo path for git operations and return canonical path."""
        raw = str(repo_path or "").strip()
        if not raw:
            return False, "repo_path is required.", ""
        normalized = os.path.realpath(os.path.abspath(raw))
        if self.workspace_root:
            root = self.workspace_root
            if normalized != root and not normalized.startswith(root + os.sep):
                return False, "repo_path must be inside the configured workspace root.", ""
        if not os.path.isdir(normalized):
            return False, "repo_path does not exist or is not a directory.", ""
        git_marker = os.path.join(normalized, ".git")
        if not os.path.exists(git_marker):
            return False, "repo_path is not a git repository.", ""
        return True, "", normalized

    @staticmethod
    def _request_ssl_context() -> ssl.SSLContext:
        """Build a TLS context with system trust and optional certifi bundle."""
        context = ssl.create_default_context()
        if certifi is not None:
            try:
                context.load_verify_locations(cafile=certifi.where())
            except Exception:
                # Fall back to system trust when certifi cannot be loaded.
                pass
        return context

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
            with urllib.request.urlopen(req, timeout=20, context=IntegrationService._request_ssl_context()) as resp:
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

    @staticmethod
    def _humanize_external_error(message: str, *, provider: str) -> str:
        raw = (message or "").strip()
        if not raw:
            return f"Could not reach {provider}. Check your internet connection and try again."
        lowered = raw.lower()
        if "certificate_verify_failed" in lowered or "ssl" in lowered:
            return (
                f"Could not establish a secure connection to {provider}. "
                "Check system certificates/network trust settings and retry."
            )
        if "timed out" in lowered or "timeout" in lowered:
            return f"{provider} did not respond in time. Check connectivity and retry."
        if any(token in lowered for token in ("name or service not known", "temporary failure in name resolution", "nodename nor servname")):
            return f"Could not resolve {provider} host. Check DNS/network and retry."
        return raw

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
                        "default_branch": repo.get("default_branch", "main"),
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
                "default_branch": body.get("default_branch", "main"),
                "html_url": body.get("html_url", ""),
                "clone_url": body.get("clone_url", ""),
            },
        }

    def github_verify_connection(self, token: str, *, repo: str = "") -> dict[str, Any]:
        token = (token or "").strip()
        repo = (repo or "").strip()
        if not token:
            return {"status": "error", "ok": False, "repo_ok": False, "message": "GitHub token is required."}

        status, body = self._github_request(token, "GET", "/user")
        if status != 200:
            message = self._humanize_external_error(
                str(body.get("message", "Failed to verify GitHub token.") or ""),
                provider="GitHub",
            )
            return {
                "status": "error",
                "ok": False,
                "repo_ok": False if repo else None,
                "http_status": status,
                "message": message,
            }

        account = {
            "login": body.get("login", ""),
            "name": body.get("name", ""),
            "html_url": body.get("html_url", ""),
        }
        repo_ok: bool | None = None
        message = "GitHub token is valid."
        if repo:
            if "/" not in repo:
                return {
                    "status": "error",
                    "ok": False,
                    "repo_ok": False,
                    "account": account,
                    "message": "Repository must be in owner/repo format.",
                }
            repo_status, repo_body = self._github_request(token, "GET", f"/repos/{repo}")
            if repo_status == 200:
                repo_ok = True
                message = f"GitHub token and repository access verified for {repo}."
            else:
                repo_ok = False
                message = self._humanize_external_error(
                    str(repo_body.get("message", f"Token verified, but repository access failed for {repo}.") or ""),
                    provider="GitHub",
                )

        return {
            "status": "ok",
            "ok": True,
            "account": account,
            "repo_ok": repo_ok,
            "message": message,
        }

    def create_branch(self, repo_path: str, *, base_branch: str, new_branch: str) -> dict[str, Any]:
        valid, message, normalized_path = self._validate_repo_path(repo_path)
        if not valid:
            return {"status": "error", "code": "invalid_repo_path", "message": message}
        ok, out = self._run_git(normalized_path, ["fetch", "origin", base_branch])
        if not ok:
            return {"status": "error", "message": out}
        ok, out = self._run_git(normalized_path, ["checkout", "-B", new_branch, f"origin/{base_branch}"])
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
        valid, message, normalized_path = self._validate_repo_path(repo_path)
        if not valid:
            return {"status": "error", "code": "invalid_repo_path", "message": message}
        patterns = {
            "OpenAI API key": re.compile(r"sk-[a-zA-Z0-9_-]{20,}"),
            "GitHub token": re.compile(r"ghp_[a-zA-Z0-9]{20,}"),
            "AWS Access Key": re.compile(r"AKIA[0-9A-Z]{16}"),
            "Private key": re.compile(r"-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----"),
        }
        findings: list[dict[str, Any]] = []
        for root, _, files in os.walk(normalized_path):
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
                                "file": os.path.relpath(path, normalized_path),
                                "snippet": match.group(0)[:60],
                            }
                        )
                        if len(findings) >= 50:
                            break
                    if len(findings) >= 50:
                        break
        return {"status": "ok", "findings": findings, "clean": len(findings) == 0}

    def sync_remote(self, repo_path: str, default_branch: str = "main") -> dict[str, Any]:
        valid, message, normalized_path = self._validate_repo_path(repo_path)
        if not valid:
            return {"status": "error", "code": "invalid_repo_path", "message": message}
        ok, fetch_out = self._run_git(normalized_path, ["fetch", "--all", "--prune"])
        if not ok:
            return {"status": "error", "message": fetch_out}
        ok, status_out = self._run_git(normalized_path, ["status", "--short", "--branch"])
        if not ok:
            return {"status": "error", "message": status_out}
        ok, rebase_out = self._run_git(normalized_path, ["pull", "--rebase", "origin", default_branch])
        return {
            "status": "ok" if ok else "warning",
            "fetch": fetch_out,
            "status_output": status_out,
            "reconcile_output": rebase_out,
        }

    def detect_drift(self, repo_path: str, default_branch: str = "main") -> dict[str, Any]:
        valid, message, normalized_path = self._validate_repo_path(repo_path)
        if not valid:
            return {"status": "error", "code": "invalid_repo_path", "message": message}
        ok, _ = self._run_git(normalized_path, ["fetch", "origin", default_branch])
        if not ok:
            return {"status": "error", "message": "Failed to fetch origin state"}
        ok, out = self._run_git(normalized_path, ["rev-list", "--left-right", "--count", f"HEAD...origin/{default_branch}"])
        if not ok:
            return {"status": "error", "message": out}
        parts = out.strip().split()
        ahead = int(parts[0]) if len(parts) > 0 and parts[0].isdigit() else 0
        behind = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
        return {"status": "ok", "ahead": ahead, "behind": behind, "drifted": ahead > 0 or behind > 0}

    def rollback_commit(self, repo_path: str, commit_sha: str) -> dict[str, Any]:
        valid, message, normalized_path = self._validate_repo_path(repo_path)
        if not valid:
            return {"status": "error", "code": "invalid_repo_path", "message": message}
        ok, out = self._run_git(normalized_path, ["revert", "--no-edit", commit_sha])
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
            with urllib.request.urlopen(req, timeout=20, context=IntegrationService._request_ssl_context()) as resp:
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

    @staticmethod
    def _netlify_request(
        token: str,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        url = f"https://api.netlify.com/api/v1{path}"
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
            with urllib.request.urlopen(req, timeout=20, context=IntegrationService._request_ssl_context()) as resp:
                body = resp.read().decode("utf-8")
                parsed: Any = json.loads(body) if body else {}
                if isinstance(parsed, dict):
                    return resp.getcode(), parsed
                return resp.getcode(), {"data": parsed}
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(body) if body else {}
            except json.JSONDecodeError:
                parsed = {"message": body}
            if isinstance(parsed, dict):
                return exc.code, parsed
            return exc.code, {"data": parsed}
        except Exception as exc:
            return 0, {"message": str(exc)}

    @staticmethod
    def _stripe_request(
        token: str,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> tuple[int, dict[str, Any]]:
        url = f"https://api.stripe.com{path}"
        data = None
        headers = {
            "Authorization": f"Bearer {token}",
            "User-Agent": "COMPaaS",
        }
        if payload is not None:
            encoded = urllib.parse.urlencode(payload)
            data = encoded.encode("utf-8")
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(
            url,
            data=data,
            method=method.upper(),
            headers=headers,
        )
        try:
            with urllib.request.urlopen(req, timeout=20, context=IntegrationService._request_ssl_context()) as resp:
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

    @staticmethod
    def _json_request(
        url: str,
        method: str,
        *,
        headers: dict[str, str] | None = None,
        payload: dict[str, Any] | list[Any] | None = None,
        timeout: int = 20,
    ) -> tuple[int, dict[str, Any]]:
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        req = urllib.request.Request(
            url,
            data=data,
            method=method.upper(),
            headers={
                "Content-Type": "application/json",
                "User-Agent": "COMPaaS",
                **(headers or {}),
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=IntegrationService._request_ssl_context()) as resp:
                body = resp.read().decode("utf-8")
                parsed: Any = json.loads(body) if body else {}
                if isinstance(parsed, dict):
                    return resp.getcode(), parsed
                return resp.getcode(), {"data": parsed}
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(body) if body else {}
            except json.JSONDecodeError:
                parsed = {"message": body}
            if isinstance(parsed, dict):
                return exc.code, parsed
            return exc.code, {"data": parsed}
        except Exception as exc:
            return 0, {"message": str(exc)}

    def vercel_link_project(self, token: str, *, name: str, team_id: str = "") -> dict[str, Any]:
        path = f"/v10/projects{f'?teamId={team_id}' if team_id else ''}"
        status, body = self._vercel_request(token, "POST", path, {"name": name})
        if status not in (200, 201):
            return {"status": "error", "http_status": status, "message": body.get("error", {}).get("message") or body.get("message", "Failed to link project")}
        return {"status": "ok", "project": body}

    def vercel_verify_connection(self, token: str, *, project_name: str = "", team_id: str = "") -> dict[str, Any]:
        token = (token or "").strip()
        project_name = (project_name or "").strip()
        team_id = (team_id or "").strip()
        if not token:
            return {"status": "error", "ok": False, "project_ok": False, "message": "Vercel token is required."}

        status, body = self._vercel_request(token, "GET", "/v2/user")
        if status != 200:
            raw_message = (
                body.get("error", {}).get("message")
                or body.get("message")
                or "Failed to verify Vercel token."
            )
            message = self._humanize_external_error(str(raw_message or ""), provider="Vercel")
            return {
                "status": "error",
                "ok": False,
                "project_ok": False if project_name else None,
                "http_status": status,
                "message": message,
            }

        user_payload = body.get("user") if isinstance(body.get("user"), dict) else body
        account = {
            "id": user_payload.get("id", "") if isinstance(user_payload, dict) else "",
            "username": user_payload.get("username", "") if isinstance(user_payload, dict) else "",
            "email": user_payload.get("email", "") if isinstance(user_payload, dict) else "",
            "name": user_payload.get("name", "") if isinstance(user_payload, dict) else "",
        }

        project_ok: bool | None = None
        message = "Vercel token is valid."
        if project_name:
            query = f"?teamId={team_id}" if team_id else ""
            project_status, project_body = self._vercel_request(token, "GET", f"/v9/projects/{project_name}{query}")
            if project_status == 200:
                project_ok = True
                message = f"Vercel token and project access verified for {project_name}."
            else:
                project_ok = False
                raw_message = (
                    project_body.get("error", {}).get("message")
                    or project_body.get("message")
                    or f"Token verified, but project access failed for {project_name}."
                )
                message = self._humanize_external_error(str(raw_message or ""), provider="Vercel")

        return {
            "status": "ok",
            "ok": True,
            "account": account,
            "project_ok": project_ok,
            "message": message,
        }

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

    def vercel_list_projects(self, token: str, *, team_id: str = "") -> dict[str, Any]:
        token = str(token or "").strip()
        if not token:
            return {"status": "error", "message": "Vercel token is required."}
        query = urllib.parse.urlencode({"teamId": team_id, "limit": 100}) if team_id else "limit=100"
        status, body = self._vercel_request(token, "GET", f"/v9/projects?{query}")
        if status != 200:
            raw_message = (
                body.get("error", {}).get("message")
                or body.get("message")
                or "Failed to list Vercel projects."
            )
            return {
                "status": "error",
                "http_status": status,
                "message": self._humanize_external_error(str(raw_message or ""), provider="Vercel"),
            }
        projects_raw = body.get("projects")
        projects: list[dict[str, Any]] = []
        if isinstance(projects_raw, list):
            for project in projects_raw:
                if not isinstance(project, dict):
                    continue
                projects.append(
                    {
                        "id": str(project.get("id", "") or "").strip(),
                        "name": str(project.get("name", "") or "").strip(),
                        "framework": str(project.get("framework", "") or "").strip(),
                        "updated_at": int(project.get("updatedAt", 0) or 0),
                    }
                )
        projects.sort(key=lambda row: (row.get("name", "") or "").lower())
        return {"status": "ok", "projects": projects}

    def netlify_verify_connection(self, token: str, *, site_id: str = "", team_id: str = "") -> dict[str, Any]:
        token = (token or "").strip()
        site_id = (site_id or "").strip()
        team_id = (team_id or "").strip()
        if not token:
            return {"status": "error", "ok": False, "site_ok": False, "message": "Netlify token is required."}

        status, body = self._netlify_request(token, "GET", "/user")
        if status != 200:
            raw_message = body.get("message") or body.get("error") or "Failed to verify Netlify token."
            message = self._humanize_external_error(str(raw_message or ""), provider="Netlify")
            return {
                "status": "error",
                "ok": False,
                "site_ok": False if site_id else None,
                "http_status": status,
                "message": message,
            }

        account = {
            "id": str(body.get("id", "") or "").strip(),
            "email": str(body.get("email", "") or "").strip(),
            "full_name": str(body.get("full_name", "") or "").strip(),
        }

        site_ok: bool | None = None
        message = "Netlify token is valid."
        if site_id:
            site_status, site_body = self._netlify_request(token, "GET", f"/sites/{site_id}")
            if site_status == 200:
                site_ok = True
                message = f"Netlify token and site access verified for {site_id}."
            else:
                site_ok = False
                raw_message = site_body.get("message") or site_body.get("error") or f"Token verified, but site access failed for {site_id}."
                message = self._humanize_external_error(str(raw_message or ""), provider="Netlify")

        return {
            "status": "ok",
            "ok": True,
            "account": account,
            "site_ok": site_ok,
            "team_id": team_id,
            "message": message,
        }

    def netlify_deploy(
        self,
        token: str,
        *,
        site_id: str,
        target: str = "preview",
        team_id: str = "",
    ) -> dict[str, Any]:
        site_id = str(site_id or "").strip()
        if not site_id:
            return {"status": "error", "message": "Netlify site ID is required."}
        normalized_target = str(target or "preview").strip().lower()
        if normalized_target not in {"preview", "production"}:
            normalized_target = "preview"

        # Site-trigger deploy flow: trigger a new build on the configured site.
        payload: dict[str, Any] = {"clear_cache": False}
        if normalized_target == "production":
            payload["trigger_title"] = "COMPaaS production deploy"
        else:
            payload["trigger_title"] = "COMPaaS preview deploy"
        status, body = self._netlify_request(token, "POST", f"/sites/{site_id}/builds", payload)
        if status not in (200, 201, 202):
            return {
                "status": "error",
                "http_status": status,
                "message": body.get("message") or body.get("error") or "Failed to trigger Netlify deploy.",
            }

        deployment_url = str(
            body.get("deploy_ssl_url")
            or body.get("ssl_url")
            or body.get("url")
            or ""
        ).strip()
        if not deployment_url:
            # Best effort fallback by site info.
            site_status, site_payload = self._netlify_request(token, "GET", f"/sites/{site_id}")
            if site_status == 200:
                deployment_url = str(
                    site_payload.get("ssl_url")
                    or site_payload.get("url")
                    or site_payload.get("custom_domain")
                    or ""
                ).strip()
        if deployment_url and not deployment_url.startswith(("http://", "https://")):
            deployment_url = f"https://{deployment_url.lstrip('/')}"

        return {
            "status": "ok",
            "target": normalized_target,
            "deployment_url": deployment_url,
            "team_id": str(team_id or "").strip(),
            "deployment": body,
        }

    def netlify_assign_domain(
        self,
        token: str,
        *,
        site_id: str,
        domain: str,
        team_id: str = "",
    ) -> dict[str, Any]:
        site_id = str(site_id or "").strip()
        domain = str(domain or "").strip()
        if not site_id or not domain:
            return {"status": "error", "message": "site_id and domain are required."}
        status, body = self._netlify_request(
            token,
            "POST",
            f"/sites/{site_id}/domains",
            {"name": domain},
        )
        if status not in (200, 201, 202):
            return {
                "status": "error",
                "http_status": status,
                "message": body.get("message") or body.get("error") or "Failed to add Netlify domain.",
            }
        return {"status": "ok", "domain": body, "team_id": str(team_id or "").strip()}

    def netlify_set_env(
        self,
        token: str,
        *,
        site_id: str,
        key: str,
        value: str,
        target: list[str] | None = None,
        team_id: str = "",
    ) -> dict[str, Any]:
        site_id = str(site_id or "").strip()
        key = str(key or "").strip()
        value = str(value or "")
        if not site_id or not key:
            return {"status": "error", "message": "site_id and key are required."}
        contexts = target or ["preview", "production"]
        payload = {
            "key": key,
            "values": [{"value": value, "context": contexts}],
        }
        status, body = self._netlify_request(
            token,
            "POST",
            f"/sites/{site_id}/env",
            payload,
        )
        if status not in (200, 201, 202):
            return {
                "status": "error",
                "http_status": status,
                "message": body.get("message") or body.get("error") or "Failed to set Netlify environment variable.",
            }
        return {"status": "ok", "result": body, "team_id": str(team_id or "").strip()}

    def netlify_list_sites(self, token: str, *, team_id: str = "") -> dict[str, Any]:
        token = str(token or "").strip()
        if not token:
            return {"status": "error", "message": "Netlify token is required."}
        status, body = self._netlify_request(token, "GET", "/sites?per_page=200")
        if status != 200:
            raw_message = body.get("message") or body.get("error") or "Failed to list Netlify sites."
            return {
                "status": "error",
                "http_status": status,
                "message": self._humanize_external_error(str(raw_message or ""), provider="Netlify"),
            }
        raw_sites = body.get("data")
        if not isinstance(raw_sites, list):
            raw_sites = body if isinstance(body, list) else []
        sites: list[dict[str, Any]] = []
        team_filter = str(team_id or "").strip()
        for site in raw_sites:
            if not isinstance(site, dict):
                continue
            account_id = str(site.get("account_id", "") or "").strip()
            account_slug = str(site.get("account_slug", "") or "").strip()
            if team_filter and team_filter not in {account_id, account_slug}:
                continue
            sites.append(
                {
                    "id": str(site.get("id", "") or "").strip(),
                    "name": str(site.get("name", "") or "").strip(),
                    "url": str(site.get("ssl_url") or site.get("url") or "").strip(),
                    "account_id": account_id,
                    "account_slug": account_slug,
                }
            )
        sites.sort(key=lambda row: (row.get("name", "") or "").lower())
        return {"status": "ok", "sites": sites}

    def stripe_verify_connection(self, secret_key: str) -> dict[str, Any]:
        token = (secret_key or "").strip()
        if not token:
            return {"status": "error", "ok": False, "message": "Stripe secret key is required."}
        status, body = self._stripe_request(token, "GET", "/v1/account")
        if status != 200:
            raw_message = (
                body.get("error", {}).get("message")
                or body.get("message")
                or "Failed to verify Stripe key."
            )
            message = self._humanize_external_error(str(raw_message or ""), provider="Stripe")
            return {
                "status": "error",
                "ok": False,
                "http_status": status,
                "message": message,
            }
        account = {
            "id": str(body.get("id", "") or "").strip(),
            "email": str(body.get("email", "") or "").strip(),
            "country": str(body.get("country", "") or "").strip(),
            "business_type": str(body.get("business_type", "") or "").strip(),
        }
        return {
            "status": "ok",
            "ok": True,
            "account": account,
            "message": "Stripe key is valid.",
        }

    def slack_send_message(
        self,
        token: str,
        *,
        channel: str,
        text: str,
        thread_ts: str = "",
    ) -> dict[str, Any]:
        token = str(token or "").strip()
        channel = str(channel or "").strip()
        text = str(text or "").strip()
        thread_ts = str(thread_ts or "").strip()
        if not token:
            return {"status": "error", "message": "Slack bot token is required."}
        if not channel:
            return {"status": "error", "message": "Slack channel is required."}
        if not text:
            return {"status": "error", "message": "Slack message text is required."}
        payload: dict[str, Any] = {"channel": channel, "text": text[:4000], "mrkdwn": True}
        if thread_ts:
            payload["thread_ts"] = thread_ts
        status, body = self._json_request(
            "https://slack.com/api/chat.postMessage",
            "POST",
            headers={"Authorization": f"Bearer {token}"},
            payload=payload,
        )
        ok = bool(body.get("ok"))
        if status != 200 or not ok:
            raw_message = body.get("error") or body.get("message") or "Failed to send Slack message."
            return {
                "status": "error",
                "http_status": status,
                "message": self._humanize_external_error(str(raw_message or ""), provider="Slack"),
            }
        return {"status": "ok", "message": body}

    def linear_verify_connection(self, api_key: str) -> dict[str, Any]:
        token = str(api_key or "").strip()
        if not token:
            return {"status": "error", "ok": False, "message": "Linear API key is required."}
        query = {"query": "query { viewer { id name email } }"}
        status, body = self._json_request(
            "https://api.linear.app/graphql",
            "POST",
            headers={"Authorization": token},
            payload=query,
        )
        errors = body.get("errors")
        if status != 200 or errors:
            message = ""
            if isinstance(errors, list) and errors and isinstance(errors[0], dict):
                message = str(errors[0].get("message", "") or "").strip()
            if not message:
                message = str(body.get("message", "") or "Failed to verify Linear key.").strip()
            return {"status": "error", "ok": False, "http_status": status, "message": message}
        viewer = body.get("data", {}).get("viewer") if isinstance(body.get("data"), dict) else {}
        if not isinstance(viewer, dict):
            viewer = {}
        return {
            "status": "ok",
            "ok": True,
            "account": {
                "id": str(viewer.get("id", "") or "").strip(),
                "name": str(viewer.get("name", "") or "").strip(),
                "email": str(viewer.get("email", "") or "").strip(),
            },
            "message": "Linear key is valid.",
        }

    def linear_create_issue(
        self,
        api_key: str,
        *,
        team_id: str,
        title: str,
        description: str = "",
        priority: int | None = None,
    ) -> dict[str, Any]:
        token = str(api_key or "").strip()
        team_id = str(team_id or "").strip()
        title = str(title or "").strip()
        description = str(description or "").strip()
        if not token:
            return {"status": "error", "message": "Linear API key is required."}
        if not team_id:
            return {"status": "error", "message": "Linear team_id is required."}
        if not title:
            return {"status": "error", "message": "Linear issue title is required."}
        input_payload: dict[str, Any] = {
            "teamId": team_id,
            "title": title[:240],
            "description": description[:10000] if description else "",
        }
        if isinstance(priority, int):
            input_payload["priority"] = max(0, min(4, priority))
        mutation = {
            "query": "mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url state { name } } } }",
            "variables": {"input": input_payload},
        }
        status, body = self._json_request(
            "https://api.linear.app/graphql",
            "POST",
            headers={"Authorization": token},
            payload=mutation,
        )
        errors = body.get("errors")
        if status != 200 or errors:
            message = ""
            if isinstance(errors, list) and errors and isinstance(errors[0], dict):
                message = str(errors[0].get("message", "") or "").strip()
            if not message:
                message = str(body.get("message", "") or "Failed to create Linear issue.").strip()
            return {"status": "error", "http_status": status, "message": message}
        result = body.get("data", {}).get("issueCreate") if isinstance(body.get("data"), dict) else {}
        if not isinstance(result, dict) or not bool(result.get("success")):
            return {"status": "error", "http_status": status, "message": "Linear rejected the issue create request."}
        issue = result.get("issue") if isinstance(result.get("issue"), dict) else {}
        return {"status": "ok", "issue": issue}

    def notion_verify_connection(self, token: str) -> dict[str, Any]:
        api_token = str(token or "").strip()
        if not api_token:
            return {"status": "error", "ok": False, "message": "Notion token is required."}
        status, body = self._json_request(
            "https://api.notion.com/v1/users/me",
            "GET",
            headers={
                "Authorization": f"Bearer {api_token}",
                "Notion-Version": "2022-06-28",
            },
            payload=None,
        )
        if status != 200:
            raw_message = body.get("message") or body.get("code") or "Failed to verify Notion token."
            return {"status": "error", "ok": False, "http_status": status, "message": str(raw_message or "")}
        user = body if isinstance(body, dict) else {}
        return {
            "status": "ok",
            "ok": True,
            "account": {
                "id": str(user.get("id", "") or "").strip(),
                "name": str(user.get("name", "") or "").strip(),
                "type": str(user.get("type", "") or "").strip(),
            },
            "message": "Notion token is valid.",
        }

    def notion_upsert_page(
        self,
        token: str,
        *,
        parent_page_id: str,
        title: str,
        markdown: str = "",
        page_id: str = "",
    ) -> dict[str, Any]:
        api_token = str(token or "").strip()
        parent_page_id = str(parent_page_id or "").strip()
        title = str(title or "").strip()
        markdown = str(markdown or "").strip()
        page_id = str(page_id or "").strip()
        if not api_token:
            return {"status": "error", "message": "Notion token is required."}
        if not title:
            return {"status": "error", "message": "Notion page title is required."}
        headers = {
            "Authorization": f"Bearer {api_token}",
            "Notion-Version": "2022-06-28",
        }
        blocks: list[dict[str, Any]] = []
        if markdown:
            for line in markdown.splitlines()[:80]:
                text = line.strip()
                if not text:
                    continue
                blocks.append(
                    {
                        "object": "block",
                        "type": "paragraph",
                        "paragraph": {"rich_text": [{"type": "text", "text": {"content": text[:1900]}}]},
                    }
                )
        if page_id:
            payload: dict[str, Any] = {
                "properties": {
                    "title": {
                        "title": [
                            {"type": "text", "text": {"content": title[:200]}},
                        ]
                    }
                }
            }
            status, body = self._json_request(
                f"https://api.notion.com/v1/pages/{urllib.parse.quote(page_id, safe='')}",
                "PATCH",
                headers=headers,
                payload=payload,
            )
            if status != 200:
                raw_message = body.get("message") or body.get("code") or "Failed to update Notion page."
                return {"status": "error", "http_status": status, "message": str(raw_message or "")}
            if blocks:
                self._json_request(
                    f"https://api.notion.com/v1/blocks/{urllib.parse.quote(page_id, safe='')}/children",
                    "PATCH",
                    headers=headers,
                    payload={"children": blocks},
                )
            return {"status": "ok", "page": body}
        if not parent_page_id:
            return {"status": "error", "message": "parent_page_id is required when creating a Notion page."}
        payload = {
            "parent": {"page_id": parent_page_id},
            "properties": {
                "title": {
                    "title": [
                        {"type": "text", "text": {"content": title[:200]}},
                    ]
                }
            },
            "children": blocks,
        }
        status, body = self._json_request(
            "https://api.notion.com/v1/pages",
            "POST",
            headers=headers,
            payload=payload,
        )
        if status != 200:
            raw_message = body.get("message") or body.get("code") or "Failed to create Notion page."
            return {"status": "error", "http_status": status, "message": str(raw_message or "")}
        return {"status": "ok", "page": body}

    def jira_verify_connection(self, *, base_url: str, email: str, api_token: str) -> dict[str, Any]:
        root = str(base_url or "").strip().rstrip("/")
        user_email = str(email or "").strip()
        token = str(api_token or "").strip()
        if not root or not user_email or not token:
            return {"status": "error", "ok": False, "message": "jira_base_url, jira_email, and jira_api_token are required."}
        auth_header = "Basic " + base64.b64encode(f"{user_email}:{token}".encode("utf-8")).decode("utf-8")
        status, body = self._json_request(
            f"{root}/rest/api/3/myself",
            "GET",
            headers={"Authorization": auth_header, "Accept": "application/json"},
            payload=None,
        )
        if status != 200:
            raw_message = body.get("errorMessages") or body.get("message") or "Failed to verify Jira credentials."
            message = str(raw_message[0] if isinstance(raw_message, list) and raw_message else raw_message)
            return {"status": "error", "ok": False, "http_status": status, "message": message}
        account = {
            "account_id": str(body.get("accountId", "") or "").strip(),
            "display_name": str(body.get("displayName", "") or "").strip(),
            "email": str(body.get("emailAddress", "") or "").strip(),
        }
        return {"status": "ok", "ok": True, "account": account, "message": "Jira credentials are valid."}

    def jira_create_issue(
        self,
        *,
        base_url: str,
        email: str,
        api_token: str,
        project_key: str,
        summary: str,
        description: str = "",
        issue_type: str = "Task",
    ) -> dict[str, Any]:
        root = str(base_url or "").strip().rstrip("/")
        user_email = str(email or "").strip()
        token = str(api_token or "").strip()
        project = str(project_key or "").strip()
        issue_summary = str(summary or "").strip()
        if not root or not user_email or not token:
            return {"status": "error", "message": "jira_base_url, jira_email, and jira_api_token are required."}
        if not project:
            return {"status": "error", "message": "project_key is required."}
        if not issue_summary:
            return {"status": "error", "message": "summary is required."}
        auth_header = "Basic " + base64.b64encode(f"{user_email}:{token}".encode("utf-8")).decode("utf-8")
        payload = {
            "fields": {
                "project": {"key": project},
                "summary": issue_summary[:255],
                "description": {
                    "type": "doc",
                    "version": 1,
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": str(description or "").strip()[:5000]}],
                        }
                    ],
                },
                "issuetype": {"name": str(issue_type or "Task").strip() or "Task"},
            }
        }
        status, body = self._json_request(
            f"{root}/rest/api/3/issue",
            "POST",
            headers={"Authorization": auth_header, "Accept": "application/json"},
            payload=payload,
        )
        if status not in {200, 201}:
            raw_message = body.get("errorMessages") or body.get("message") or "Failed to create Jira issue."
            message = str(raw_message[0] if isinstance(raw_message, list) and raw_message else raw_message)
            return {"status": "error", "http_status": status, "message": message}
        return {"status": "ok", "issue": body}

    def jira_transition_issue(
        self,
        *,
        base_url: str,
        email: str,
        api_token: str,
        issue_key: str,
        transition_id: str,
    ) -> dict[str, Any]:
        root = str(base_url or "").strip().rstrip("/")
        user_email = str(email or "").strip()
        token = str(api_token or "").strip()
        issue = str(issue_key or "").strip()
        transition = str(transition_id or "").strip()
        if not root or not user_email or not token:
            return {"status": "error", "message": "jira_base_url, jira_email, and jira_api_token are required."}
        if not issue or not transition:
            return {"status": "error", "message": "issue_key and transition_id are required."}
        auth_header = "Basic " + base64.b64encode(f"{user_email}:{token}".encode("utf-8")).decode("utf-8")
        status, body = self._json_request(
            f"{root}/rest/api/3/issue/{urllib.parse.quote(issue, safe='')}/transitions",
            "POST",
            headers={"Authorization": auth_header, "Accept": "application/json"},
            payload={"transition": {"id": transition}},
        )
        if status not in {200, 204}:
            raw_message = body.get("errorMessages") or body.get("message") or "Failed to transition Jira issue."
            message = str(raw_message[0] if isinstance(raw_message, list) and raw_message else raw_message)
            return {"status": "error", "http_status": status, "message": message}
        return {"status": "ok", "issue_key": issue, "transition_id": transition}

    def gitlab_verify_connection(self, *, base_url: str, token: str, project_id: str = "") -> dict[str, Any]:
        root = str(base_url or "https://gitlab.com").strip().rstrip("/")
        api_token = str(token or "").strip()
        pid = str(project_id or "").strip()
        if not api_token:
            return {"status": "error", "ok": False, "message": "GitLab token is required."}
        headers = {"PRIVATE-TOKEN": api_token}
        status, body = self._json_request(
            f"{root}/api/v4/user",
            "GET",
            headers=headers,
            payload=None,
        )
        if status != 200:
            raw_message = body.get("message") or "Failed to verify GitLab token."
            return {"status": "error", "ok": False, "http_status": status, "message": str(raw_message or "")}
        account = {
            "id": body.get("id"),
            "username": str(body.get("username", "") or "").strip(),
            "name": str(body.get("name", "") or "").strip(),
            "web_url": str(body.get("web_url", "") or "").strip(),
        }
        project_ok: bool | None = None
        if pid:
            project_status, _project_body = self._json_request(
                f"{root}/api/v4/projects/{urllib.parse.quote(pid, safe='')}",
                "GET",
                headers=headers,
                payload=None,
            )
            project_ok = project_status == 200
        return {
            "status": "ok",
            "ok": True,
            "account": account,
            "project_ok": project_ok,
            "message": "GitLab token is valid.",
        }

    def gitlab_create_branch(
        self,
        *,
        base_url: str,
        token: str,
        project_id: str,
        branch: str,
        ref: str = "main",
    ) -> dict[str, Any]:
        root = str(base_url or "https://gitlab.com").strip().rstrip("/")
        api_token = str(token or "").strip()
        pid = str(project_id or "").strip()
        branch_name = str(branch or "").strip()
        ref_name = str(ref or "main").strip() or "main"
        if not api_token:
            return {"status": "error", "message": "GitLab token is required."}
        if not pid or not branch_name:
            return {"status": "error", "message": "project_id and branch are required."}
        query = urllib.parse.urlencode({"branch": branch_name, "ref": ref_name})
        status, body = self._json_request(
            f"{root}/api/v4/projects/{urllib.parse.quote(pid, safe='')}/repository/branches?{query}",
            "POST",
            headers={"PRIVATE-TOKEN": api_token},
            payload=None,
        )
        if status not in {200, 201}:
            raw_message = body.get("message") or "Failed to create GitLab branch."
            return {"status": "error", "http_status": status, "message": str(raw_message or "")}
        return {"status": "ok", "branch": body}

    def gitlab_create_merge_request(
        self,
        *,
        base_url: str,
        token: str,
        project_id: str,
        source_branch: str,
        target_branch: str,
        title: str,
        description: str = "",
    ) -> dict[str, Any]:
        root = str(base_url or "https://gitlab.com").strip().rstrip("/")
        api_token = str(token or "").strip()
        pid = str(project_id or "").strip()
        source = str(source_branch or "").strip()
        target = str(target_branch or "").strip()
        mr_title = str(title or "").strip()
        if not api_token:
            return {"status": "error", "message": "GitLab token is required."}
        if not pid or not source or not target or not mr_title:
            return {"status": "error", "message": "project_id, source_branch, target_branch, and title are required."}
        payload = {
            "source_branch": source,
            "target_branch": target,
            "title": mr_title[:255],
            "description": str(description or "").strip()[:8000],
            "remove_source_branch": False,
        }
        status, body = self._json_request(
            f"{root}/api/v4/projects/{urllib.parse.quote(pid, safe='')}/merge_requests",
            "POST",
            headers={"PRIVATE-TOKEN": api_token},
            payload=payload,
        )
        if status not in {200, 201}:
            raw_message = body.get("message") or "Failed to create GitLab merge request."
            return {"status": "error", "http_status": status, "message": str(raw_message or "")}
        return {"status": "ok", "merge_request": body}

    @staticmethod
    def detect_project_stack(workspace_path: str) -> str:
        root = str(workspace_path or "").strip()
        if not root:
            return "generic"
        pkg_path = os.path.join(root, "package.json")
        pyproject_path = os.path.join(root, "pyproject.toml")
        requirements_path = os.path.join(root, "requirements.txt")
        if os.path.exists(pkg_path):
            return "node"
        if os.path.exists(pyproject_path) or os.path.exists(requirements_path):
            return "python"
        return "generic"

    @staticmethod
    def build_stripe_billing_pack(
        *,
        project_name: str,
        workspace_path: str,
        stack: str,
        publishable_key: str = "",
        has_secret_key: bool = False,
        price_basic: str = "",
        price_pro: str = "",
    ) -> str:
        stack_setup = {
            "node": [
                "1. Install dependency: `npm install stripe`",
                "2. Add API routes for checkout session and portal session.",
                "3. Store secrets in `.env` and never ship secret keys to the browser.",
            ],
            "python": [
                "1. Install dependency: `pip install stripe`",
                "2. Add backend endpoints for checkout and customer portal.",
                "3. Keep secret keys server-side only and load from environment variables.",
            ],
            "generic": [
                "1. Add backend endpoints for checkout and billing portal.",
                "2. Keep secret keys in server-only environment variables.",
                "3. Integrate webhook handling before enabling production mode.",
            ],
        }
        setup_steps = stack_setup.get(stack, stack_setup["generic"])
        workspace_hint = workspace_path or "(workspace not set)"
        lines = [
            f"# Billing Pack: {project_name or 'Project'}",
            "",
            "## Summary",
            "- Stripe billing scaffold instructions generated by COMPaaS.",
            "- Default mode is test/sandbox. Switch to production only after webhook validation.",
            "",
            "## Environment Variables",
            f"- `STRIPE_SECRET_KEY={'***configured***' if has_secret_key else '<set in Settings → Integrations>'}`",
            f"- `STRIPE_PUBLISHABLE_KEY={publishable_key or '<set in Settings → Integrations>'}",
            f"- `STRIPE_PRICE_BASIC={price_basic or '<optional>'}",
            f"- `STRIPE_PRICE_PRO={price_pro or '<optional>'}",
            "- `STRIPE_WEBHOOK_SECRET=<set after creating endpoint in Stripe Dashboard>`",
            "",
            "## Stack Detection",
            f"- Detected stack: `{stack}`",
            f"- Workspace: `{workspace_hint}`",
            "",
            "## Implementation Steps",
        ]
        lines.extend(f"- {step}" for step in setup_steps)
        lines.extend(
            [
                "",
                "## Webhook Checklist",
                "- Create webhook endpoint in Stripe Dashboard.",
                "- Listen to: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.",
                "- Verify webhook signature with `STRIPE_WEBHOOK_SECRET`.",
                "",
                "## Test Mode Validation",
                "- Use Stripe test cards (e.g., `4242 4242 4242 4242`).",
                "- Verify successful checkout + portal access.",
                "- Confirm webhook events are received and logged.",
                "",
                "## Vercel Sync (Optional)",
                "- If Vercel is connected, add Stripe env vars to preview and production environments.",
                "- Redeploy after env updates.",
            ]
        )
        return "\n".join(lines).strip() + "\n"

    def vercel_deploy_saved(
        self,
        integrations: dict[str, Any],
        *,
        target: str = "preview",
        git_source: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        token = str(integrations.get("vercel_token", "") or "").strip()
        project_name = str(integrations.get("vercel_project_name", "") or "").strip()
        team_id = str(integrations.get("vercel_team_id", "") or "").strip()
        normalized_target = str(target or "preview").strip().lower()
        if normalized_target not in {"preview", "production"}:
            normalized_target = "preview"
        if not token or not project_name:
            return {
                "status": "error",
                "message": "Vercel is not fully configured. Add token and project name first.",
            }
        deployment = self.vercel_deploy(
            token,
            project_name=project_name,
            team_id=team_id,
            target=normalized_target,
            git_source=git_source,
        )
        if deployment.get("status") != "ok":
            return deployment

        deployment_body = deployment.get("deployment", {})
        deployment_url = ""
        if isinstance(deployment_body, dict):
            deployment_url = str(
                deployment_body.get("url")
                or deployment_body.get("inspectorUrl")
                or ""
            ).strip()
        if deployment_url and not deployment_url.startswith(("http://", "https://")):
            deployment_url = f"https://{deployment_url.lstrip('/')}"

        return {
            "status": "ok",
            "target": normalized_target,
            "deployment_url": deployment_url,
            "deployment": deployment_body,
        }

    def netlify_deploy_saved(
        self,
        integrations: dict[str, Any],
        *,
        target: str = "preview",
    ) -> dict[str, Any]:
        token = str(integrations.get("netlify_token", "") or "").strip()
        site_id = str(integrations.get("netlify_site_id", "") or "").strip()
        team_id = str(integrations.get("netlify_team_id", "") or "").strip()
        normalized_target = str(target or "preview").strip().lower()
        if normalized_target not in {"preview", "production"}:
            normalized_target = "preview"
        if not token or not site_id:
            return {
                "status": "error",
                "message": "Netlify is not fully configured. Add token and site ID first.",
            }
        deployment = self.netlify_deploy(
            token,
            site_id=site_id,
            target=normalized_target,
            team_id=team_id,
        )
        if deployment.get("status") != "ok":
            return deployment
        return deployment
