#!/usr/bin/env bash
set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGO_PATH="$SCRIPT_DIR/web-dashboard/public/compass-rose.svg"

print_banner() {
    if command -v chafa &>/dev/null && [ -f "$LOGO_PATH" ]; then
        # Render the real logo when an image-to-terminal renderer is available.
        chafa --size 30x15 "$LOGO_PATH" 2>/dev/null || true
        echo -e "${PURPLE}"
    else
        echo -e "${PURPLE}"
        cat << 'COMPASS'
                \   |   /
                 .-*-.
            ----(  +  )----
                 '-*-'
                /   |   \
COMPASS
    fi

    cat << 'WORDMARK'
 .d8888b.   .d88888b.  888b     d888 8888888b.                    .d8888b.
d88P  Y88b d88P" "Y88b 8888b   d8888 888   Y88b                  d88P  Y88b
888    888 888     888 88888b.d88888 888    888                  Y88b.
888        888     888 888Y88888P888 888   d88P 8888b.   8888b.   "Y888b.
888        888     888 888 Y888P 888 8888888P"     "88b     "88b     "Y88b.
888    888 888     888 888  Y8P  888 888       .d888888 .d888888       "888
Y88b  d88P Y88b. .d88P 888   "   888 888       888  888 888  888 Y88b  d88P
 "Y8888P"   "Y88888P"  888       888 888       "Y888888 "Y888888  "Y8888P"
WORDMARK
    echo -e "${NC}"
    echo -e "${BLUE}=== COMPaaS Virtual Company - Installation ===${NC}"
    echo -e "${BLUE}=== Built by Idan H. ===${NC}"
    echo ""
}

print_banner

offer_cli_install() {
    local cli_label="$1"
    local cli_bin="$2"
    local npm_package="$3"

    if command -v "$cli_bin" &>/dev/null; then
        echo -e "${GREEN}  ✓ ${cli_label} found${NC}"
        return 0
    fi

    echo -e "${YELLOW}  ⚠ ${cli_label} not found${NC}"
    echo -e "${YELLOW}    Required for ${cli_label} provider mode${NC}"
    echo -e "${YELLOW}    Install command: npm install -g ${npm_package}${NC}"

    if ! command -v npm &>/dev/null; then
        echo -e "${YELLOW}    npm is unavailable, skipping auto-install${NC}"
        return 0
    fi

    if [ -t 0 ]; then
        read -r -p "  Install ${cli_label} now? [y/N] " INSTALL_NOW
    else
        INSTALL_NOW="n"
    fi
    INSTALL_NOW=${INSTALL_NOW:-N}

    if [[ "$INSTALL_NOW" =~ ^[Yy]$ ]]; then
        if npm install -g "$npm_package"; then
            if command -v "$cli_bin" &>/dev/null; then
                echo -e "${GREEN}  ✓ ${cli_label} installed${NC}"
            else
                echo -e "${YELLOW}  ⚠ ${cli_label} install completed but command is not available yet. Re-open terminal and retry.${NC}"
            fi
        else
            echo -e "${YELLOW}  ⚠ Failed to install ${cli_label}; continuing setup${NC}"
        fi
    else
        echo -e "${YELLOW}  ↷ Skipping ${cli_label} installation${NC}"
    fi
}

run_with_privilege() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
        return $?
    fi
    if command -v sudo &>/dev/null; then
        sudo "$@"
        return $?
    fi
    echo -e "${RED}ERROR: sudo is required to auto-install Python.${NC}"
    return 1
}

refresh_homebrew_shellenv() {
    if [ -x /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
        return 0
    fi
    if [ -x /usr/local/bin/brew ]; then
        eval "$(/usr/local/bin/brew shellenv)"
        return 0
    fi
    return 1
}

install_python3_auto() {
    local os_name
    os_name="$(uname -s)"

    if [ "$os_name" = "Darwin" ]; then
        if ! command -v brew &>/dev/null; then
            echo -e "${YELLOW}  ⚠ Homebrew not found. Installing Homebrew first...${NC}"
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            refresh_homebrew_shellenv || true
        fi

        if ! command -v brew &>/dev/null; then
            echo -e "${RED}ERROR: Homebrew installation failed; cannot auto-install Python.${NC}"
            return 1
        fi

        brew install python
        return $?
    fi

    if command -v apt-get &>/dev/null; then
        run_with_privilege apt-get update
        run_with_privilege apt-get install -y python3 python3-venv python3-pip
        return $?
    fi
    if command -v dnf &>/dev/null; then
        run_with_privilege dnf install -y python3 python3-pip
        return $?
    fi
    if command -v yum &>/dev/null; then
        run_with_privilege yum install -y python3 python3-pip
        return $?
    fi
    if command -v pacman &>/dev/null; then
        run_with_privilege pacman -Sy --noconfirm python python-pip
        return $?
    fi
    if command -v zypper &>/dev/null; then
        run_with_privilege zypper --non-interactive install python3 python3-pip
        return $?
    fi
    if command -v apk &>/dev/null; then
        run_with_privilege apk add --no-cache python3 py3-pip
        return $?
    fi

    echo -e "${RED}ERROR: Unsupported OS/package manager for automatic Python installation.${NC}"
    return 1
}

check_python_version() {
    if ! command -v python3 &>/dev/null; then
        return 2
    fi

    PY_VERSION=$(python3 -c "import sys; v=sys.version_info; print(f'{v.major}.{v.minor}')")
    local py_major py_minor
    py_major=$(echo "$PY_VERSION" | cut -d. -f1)
    py_minor=$(echo "$PY_VERSION" | cut -d. -f2)

    if [ "$py_major" -lt 3 ] || ([ "$py_major" -eq 3 ] && [ "$py_minor" -lt 10 ]); then
        return 3
    fi
    return 0
}

ensure_python_ready() {
    local status
    if check_python_version; then
        echo -e "${GREEN}  ✓ Python $PY_VERSION${NC}"
        return 0
    fi
    status=$?

    if [ "$status" -eq 2 ]; then
        echo -e "${YELLOW}  ⚠ Python 3 is not installed.${NC}"
    else
        echo -e "${YELLOW}  ⚠ Python 3.10+ is required (found $PY_VERSION).${NC}"
    fi

    if [ ! -t 0 ]; then
        echo -e "${RED}ERROR: Non-interactive mode cannot auto-install Python. Install Python 3.10+ and rerun.${NC}"
        return 1
    fi

    local install_python_now
    read -r -p "  Press Enter to install the latest Python 3 and continue, or type 'n' to cancel: " install_python_now
    if [[ "${install_python_now:-}" =~ ^[Nn]$ ]]; then
        echo -e "${RED}ERROR: Python installation canceled. Install Python 3.10+ and rerun.${NC}"
        return 1
    fi

    echo -e "${YELLOW}  Installing Python...${NC}"
    if ! install_python3_auto; then
        echo -e "${RED}ERROR: Automatic Python installation failed. Install Python manually and rerun.${NC}"
        return 1
    fi

    refresh_homebrew_shellenv || true
    hash -r

    if ! check_python_version; then
        echo -e "${RED}ERROR: Python 3.10+ is still unavailable on PATH after installation.${NC}"
        echo -e "${YELLOW}Please restart your terminal (if needed), then rerun install.sh.${NC}"
        return 1
    fi

    echo -e "${GREEN}  ✓ Python $PY_VERSION${NC}"
    return 0
}

# 1. Check Python 3.10+
echo -e "${YELLOW}[1/8] Checking Python...${NC}"
if ! ensure_python_ready; then
    exit 1
fi

# 2. Check Node.js (optional, for web dashboard)
echo -e "${YELLOW}[2/8] Checking Node.js (optional, for web dashboard)...${NC}"
if command -v node &>/dev/null; then
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}  ✓ Node.js $NODE_VERSION${NC}"
    HAS_NODE=true
else
    echo -e "${YELLOW}  ⚠ Node.js not found — web dashboard will not be built${NC}"
    echo -e "${YELLOW}    Install Node.js 18+ to enable the web dashboard${NC}"
    HAS_NODE=false
fi

# 3. Check optional AI CLIs
echo -e "${YELLOW}[3/8] Checking AI runtime CLIs (optional)...${NC}"
offer_cli_install "Claude Code CLI" "claude" "@anthropic-ai/claude-code"
offer_cli_install "Codex CLI" "codex" "@openai/codex"
if command -v ollama &>/dev/null; then
    echo -e "${GREEN}  ✓ Ollama found${NC}"
else
    echo -e "${YELLOW}  ⚠ Ollama not found (optional for local model mode)${NC}"
    echo -e "${YELLOW}    Install: https://ollama.com/download${NC}"
fi

# 4. Create Python virtual environment
echo -e "${YELLOW}[4/8] Setting up Python virtual environment...${NC}"
cd "$SCRIPT_DIR"
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
    echo -e "${GREEN}  ✓ Virtual environment created${NC}"
else
    echo -e "${GREEN}  ✓ Virtual environment already exists${NC}"
fi
source .venv/bin/activate

# 5. Install Python dependencies
echo -e "${YELLOW}[5/8] Installing Python dependencies...${NC}"
pip3 install -e ".[dev,local-models]" --quiet
echo -e "${GREEN}  ✓ Python dependencies installed${NC}"

# 6. Build web dashboard (if Node.js available)
echo -e "${YELLOW}[6/8] Building web dashboard...${NC}"
if [ "$HAS_NODE" = true ] && [ -d "web-dashboard" ]; then
    cd web-dashboard
    npm install --quiet 2>/dev/null
    npm run build --quiet 2>/dev/null
    cd "$SCRIPT_DIR"
    echo -e "${GREEN}  ✓ Web dashboard built${NC}"
else
    echo -e "${YELLOW}  ⚠ Skipped (Node.js not available or web-dashboard/ not found)${NC}"
fi

# 7. Initialize directories and environment
echo -e "${YELLOW}[7/8] Initializing environment...${NC}"
mkdir -p company_data/projects
mkdir -p ~/projects

# Fresh installs should start with an empty runtime state (no test/demo history).
if [ ! -f company_data/config.yaml ]; then
    rm -rf company_data/*
    mkdir -p company_data/projects
fi

# Create .env if it doesn't exist
if [ ! -f .env ]; then
    cp .env.example .env 2>/dev/null || cat > .env << 'ENVEOF'
# COMPaaS Configuration
# Optional: Your cloud provider API keys
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Optional: Override data directory (default: ./company_data)
# COMPAAS_DATA_DIR=./company_data

# Optional: Override project output directory (default: ~/projects)
# PROJECTS_OUTPUT_DIR=~/projects
ENVEOF
    echo -e "${YELLOW}  ⚠ Created .env file — set provider keys if you use cloud models${NC}"
else
    echo -e "${GREEN}  ✓ .env already exists${NC}"
fi

# Make hooks executable
chmod +x scripts/hooks/*.sh 2>/dev/null || true
echo -e "${GREEN}  ✓ Hooks made executable${NC}"

# 8. Run tests
echo -e "${YELLOW}[8/8] Running tests...${NC}"
TEST_SANDBOX_DIR="$(mktemp -d "${TMPDIR:-/tmp}/compaas-install-tests-XXXXXX")"
TEST_DATA_DIR="$TEST_SANDBOX_DIR/company_data"
TEST_WORKSPACE_DIR="$TEST_SANDBOX_DIR/projects"
mkdir -p "$TEST_DATA_DIR" "$TEST_WORKSPACE_DIR"
if COMPAAS_DATA_DIR="$TEST_DATA_DIR" COMPAAS_WORKSPACE_ROOT="$TEST_WORKSPACE_DIR" python3 -m pytest tests/ -q 2>/dev/null; then
    echo -e "${GREEN}  ✓ All tests passed${NC}"
else
    echo -e "${RED}  ✗ Some tests failed — check output above${NC}"
fi
rm -rf "$TEST_SANDBOX_DIR"

# Done!
echo ""
echo -e "${PURPLE}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Installation Complete!${NC}"
echo -e "${PURPLE}═══════════════════════════════════════════${NC}"
echo -e "${BLUE}  Built by Idan H.${NC}"
echo ""
echo -e "  ${BLUE}Getting started:${NC}"
echo ""
echo -e "  1. Activate venv:      ${YELLOW}source .venv/bin/activate${NC}"
echo -e "  2. Start dashboard:    ${YELLOW}compaas-web${NC}   (opens at http://localhost:8420)"
echo -e "  3. Run setup wizard:   Choose provider (Anthropic / OpenAI / local Ollama)"
echo ""

if [ -t 0 ]; then
    echo ""
    echo "Select startup mode:"
    echo "  1) Web dashboard (recommended)"
    echo "  2) API server only (no browser auto-open)"
    read -r -p "Choice [1-2, default 1]: " START_MODE
    START_MODE=${START_MODE:-1}

    case "$START_MODE" in
        1)
            echo -e "${GREEN}Starting COMPaaS web dashboard...${NC}"
            ./.venv/bin/compaas-web
            ;;
        2)
            echo -e "${GREEN}Starting COMPaaS API server (headless)...${NC}"
            COMPAAS_NO_BROWSER=true ./.venv/bin/compaas-web
            ;;
        *)
            echo -e "${YELLOW}Unknown choice. Skipping auto-start.${NC}"
            ;;
    esac
else
    echo -e "${YELLOW}Non-interactive shell detected. Skipping auto-start.${NC}"
fi
