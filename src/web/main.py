"""COMPaaS Web Dashboard — entry point."""
import os
import subprocess
import sys
import threading
import webbrowser

import uvicorn


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
    try:
        from scripts.render_agents import render_templates
        count = render_templates()
        if count:
            print(f"[COMPaaS] Rendered {count} agent template(s).")
    except Exception as exc:
        print(f"[COMPaaS] Warning: Agent template rendering failed: {exc}", file=sys.stderr)


def main():
    host = os.environ.get("COMPAAS_API_HOST", "127.0.0.1")
    port = int(os.environ.get("COMPAAS_API_PORT", "8420"))
    debug = os.environ.get("COMPAAS_DEBUG", "").lower() == "true"

    # Build frontend if dist is missing
    _ensure_frontend_built()

    # Render agent templates with current config values
    _render_agent_templates()

    # Auto-open browser after a short delay (set COMPAAS_NO_BROWSER=true to disable)
    if os.environ.get("COMPAAS_NO_BROWSER", "").lower() != "true":
        url = f"http://{host}:{port}"
        threading.Timer(1.5, webbrowser.open, args=[url]).start()

    uvicorn.run("src.web.api:app", host=host, port=port, reload=debug)


if __name__ == "__main__":
    main()
