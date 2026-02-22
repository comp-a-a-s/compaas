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
    echo -e "${BLUE}=== Built by Idan Hen ===${NC}"
    echo ""
}

print_banner

# 1. Check Python 3.10+
echo -e "${YELLOW}[1/8] Checking Python...${NC}"
if ! command -v python3 &>/dev/null; then
    echo -e "${RED}ERROR: python3 not found. Install Python 3.10+${NC}"
    exit 1
fi
PY_VERSION=$(python3 -c "import sys; v=sys.version_info; print(f'{v.major}.{v.minor}')")
PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)
if [ "$PY_MAJOR" -lt 3 ] || ([ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]); then
    echo -e "${RED}ERROR: Python 3.10+ required (found $PY_VERSION)${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ Python $PY_VERSION${NC}"

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
if command -v claude &>/dev/null; then
    echo -e "${GREEN}  ✓ Claude Code CLI found${NC}"
else
    echo -e "${YELLOW}  ⚠ Claude Code CLI not found (needed for Anthropic CLI mode)${NC}"
    echo -e "${YELLOW}    Install: npm install -g @anthropic-ai/claude-code${NC}"
fi
if command -v codex &>/dev/null; then
    echo -e "${GREEN}  ✓ Codex CLI found${NC}"
else
    echo -e "${YELLOW}  ⚠ Codex CLI not found (needed for OpenAI Codex mode)${NC}"
    echo -e "${YELLOW}    Install: npm install -g @openai/codex${NC}"
fi
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
echo -e "${BLUE}  Built by Idan Hen${NC}"
echo ""
echo -e "  ${BLUE}Getting started:${NC}"
echo ""
echo -e "  1. Activate venv:      ${YELLOW}source .venv/bin/activate${NC}"
echo -e "  2. Start dashboard:    ${YELLOW}compaas-web${NC}   (opens at http://localhost:8420)"
echo -e "  3. Run setup wizard:   Choose provider (Anthropic / OpenAI / local Ollama)"
echo ""

if [ -t 0 ]; then
    read -r -p "Start COMPaaS now? [Y/n] " START_NOW
else
    START_NOW="n"
fi
START_NOW=${START_NOW:-Y}

if [[ "$START_NOW" =~ ^[Yy]$ ]]; then
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
fi
