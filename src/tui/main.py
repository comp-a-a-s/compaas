"""Entry point for the Virtual Company TUI Dashboard."""

from src.tui.app import VirtualCompanyDashboard


def main():
    app = VirtualCompanyDashboard()
    app.run()


if __name__ == "__main__":
    main()
