"""CrackPie Web Dashboard — entry point."""
import os
import threading
import webbrowser

import uvicorn


def main():
    host = os.environ.get("CRACKPIE_API_HOST", "127.0.0.1")
    port = int(os.environ.get("CRACKPIE_API_PORT", "8420"))
    debug = os.environ.get("CRACKPIE_DEBUG", "").lower() == "true"

    # Auto-open browser after a short delay (set CRACKPIE_NO_BROWSER=true to disable)
    if os.environ.get("CRACKPIE_NO_BROWSER", "").lower() != "true":
        url = f"http://{host}:{port}"
        threading.Timer(1.5, webbrowser.open, args=[url]).start()

    uvicorn.run("src.web.api:app", host=host, port=port, reload=debug)


if __name__ == "__main__":
    main()
