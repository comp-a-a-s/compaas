"""COMPaaS Web Dashboard — entry point."""
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser

import uvicorn

from src.web.template_rendering import render_agent_templates


def _ensure_frontend_built() -> None:
    """Build the React frontend if the dist/assets directory is missing."""
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    dist_assets = os.path.join(project_root, "web-dashboard", "dist", "assets")
    if os.path.isdir(dist_assets) and os.listdir(dist_assets):
        return  # Already built

    web_dir = os.path.join(project_root, "web-dashboard")
    if not os.path.isdir(web_dir):
        return  # No frontend source

    node_modules = os.path.join(web_dir, "node_modules")
    try:
        if not os.path.isdir(node_modules):
            print("[COMPaaS] Installing frontend dependencies...")
            subprocess.run(["npm", "install"], cwd=web_dir, check=True)

        print("[COMPaaS] Building frontend...")
        subprocess.run(["npm", "run", "build"], cwd=web_dir, check=True)
        print("[COMPaaS] Frontend built successfully.")
    except FileNotFoundError:
        print("[COMPaaS] Warning: npm not found. Install Node.js to build the frontend.", file=sys.stderr)
        print("[COMPaaS]   Then run: cd web-dashboard && npm install && npm run build", file=sys.stderr)
    except subprocess.CalledProcessError as exc:
        print(f"[COMPaaS] Warning: Frontend build failed (exit code {exc.returncode}).", file=sys.stderr)


def _render_agent_templates() -> None:
    """Render agent templates with dynamic names from config."""
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    try:
        count = render_agent_templates(project_root)
        if count:
            print(f"[COMPaaS] Rendered {count} agent template(s).")
    except Exception as exc:
        print(f"[COMPaaS] Warning: Agent template rendering failed: {exc}", file=sys.stderr)


def _start_browser_opener(host: str, port: int) -> None:
    """Open browser only after API health is reachable and startup buffer elapsed."""
    if os.environ.get("COMPAAS_NO_BROWSER", "").lower() == "true":
        return

    open_host = "127.0.0.1" if host in {"0.0.0.0", "::", "[::]"} else host
    base_url = f"http://{open_host}:{port}"
    health_url = f"{base_url}/api/health"

    min_delay_s = max(2.0, float(os.environ.get("COMPAAS_BROWSER_MIN_DELAY_SECONDS", "6.0")))
    ready_timeout_s = max(min_delay_s, float(os.environ.get("COMPAAS_BROWSER_READY_TIMEOUT_SECONDS", "45.0")))
    start = time.monotonic()

    print("[COMPaaS] Starting web server...")
    print("[COMPaaS] Loading dashboard. Browser will open automatically when server is ready.")

    def _wait_and_open() -> None:
        next_progress_log_at = 0.0
        while True:
            elapsed = time.monotonic() - start
            server_ready = False
            try:
                with urllib.request.urlopen(health_url, timeout=1.5) as response:
                    server_ready = response.status == 200
            except (urllib.error.URLError, TimeoutError, ValueError):
                server_ready = False

            if server_ready and elapsed >= min_delay_s:
                print(f"[COMPaaS] Server ready. Opening {base_url}")
                webbrowser.open(base_url)
                return

            if elapsed >= ready_timeout_s:
                if elapsed < min_delay_s:
                    time.sleep(min_delay_s - elapsed)
                print(f"[COMPaaS] Startup health probe timed out. Opening {base_url}")
                webbrowser.open(base_url)
                return

            if elapsed >= next_progress_log_at:
                if elapsed < min_delay_s:
                    remaining = max(0.0, min_delay_s - elapsed)
                    print(f"[COMPaaS] Loading dashboard... ({remaining:.1f}s minimum startup buffer)")
                else:
                    print("[COMPaaS] Loading dashboard... (waiting for API health check)")
                next_progress_log_at = elapsed + 1.5

            time.sleep(0.35)

    threading.Thread(target=_wait_and_open, daemon=True).start()


def main():
    host = os.environ.get("COMPAAS_API_HOST", "127.0.0.1")
    port = int(os.environ.get("COMPAAS_API_PORT", "8420"))
    debug = os.environ.get("COMPAAS_DEBUG", "").lower() == "true"

    # Build frontend if dist is missing
    _ensure_frontend_built()

    # Render agent templates with current config values
    _render_agent_templates()

    _start_browser_opener(host, port)

    uvicorn.run("src.web.api:app", host=host, port=port, reload=debug)


if __name__ == "__main__":
    main()
