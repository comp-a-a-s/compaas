"""CrackPie Web Dashboard — entry point."""
import os
import uvicorn


def main():
    host = os.environ.get("CRACKPIE_API_HOST", "127.0.0.1")
    port = int(os.environ.get("CRACKPIE_API_PORT", "8420"))
    debug = os.environ.get("CRACKPIE_DEBUG", "").lower() == "true"
    uvicorn.run("src.web.api:app", host=host, port=port, reload=debug)


if __name__ == "__main__":
    main()
