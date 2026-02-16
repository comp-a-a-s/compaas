"""CrackPie Web Dashboard — entry point."""
import uvicorn


def main():
    uvicorn.run("src.web.api:app", host="0.0.0.0", port=8420, reload=True)


if __name__ == "__main__":
    main()
