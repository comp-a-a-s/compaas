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
   CCCC   OOO   M   M  PPPP    A    A    SSS
  C      O   O  MM MM  P   P  A A  A A  S
  C      O   O  M M M  PPPP   AAAAAAAA   SSS
  C      O   O  M   M  P      A      A      S
   CCCC   OOO   M   M  P      A      A   SSS
WORDMARK
    echo -e "${NC}"
    echo -e "${BLUE}=== COMPaaS Virtual Company - Installation ===${NC}"
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

# 3. Check Claude Code CLI
echo -e "${YELLOW}[3/8] Checking Claude Code CLI...${NC}"
if command -v claude &>/dev/null; then
    echo -e "${GREEN}  ✓ Claude Code CLI found${NC}"
else
    echo -e "${YELLOW}  ⚠ Claude Code CLI not found${NC}"
    echo -e "${YELLOW}    Install: npm install -g @anthropic-ai/claude-code${NC}"
    echo -e "${YELLOW}    COMPaaS needs Claude Code to run agents${NC}"
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
pip3 install -e ".[dev]" --quiet
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

# Create .env if it doesn't exist
if [ ! -f .env ]; then
    cp .env.example .env 2>/dev/null || cat > .env << 'ENVEOF'
# COMPaaS Configuration
# Required: Your Anthropic API key
ANTHROPIC_API_KEY=

# Optional: Override data directory (default: ./company_data)
# COMPAAS_DATA_DIR=./company_data

# Optional: Override project output directory (default: ~/projects)
# PROJECTS_OUTPUT_DIR=~/projects
ENVEOF
    echo -e "${YELLOW}  ⚠ Created .env file — please set your ANTHROPIC_API_KEY${NC}"
else
    echo -e "${GREEN}  ✓ .env already exists${NC}"
fi

# Make hooks executable
chmod +x scripts/hooks/*.sh 2>/dev/null || true
echo -e "${GREEN}  ✓ Hooks made executable${NC}"

# 8. Run tests
echo -e "${YELLOW}[8/8] Running tests...${NC}"
if python3 -m pytest tests/ -q 2>/dev/null; then
    echo -e "${GREEN}  ✓ All tests passed${NC}"
else
    echo -e "${RED}  ✗ Some tests failed — check output above${NC}"
fi

# Done!
echo ""
echo -e "${PURPLE}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Installation Complete!${NC}"
echo -e "${PURPLE}═══════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BLUE}Getting started:${NC}"
echo ""
echo -e "  1. Set your API key:   ${YELLOW}echo 'ANTHROPIC_API_KEY=sk-...' >> .env${NC}"
echo -e "  2. Activate venv:      ${YELLOW}source .venv/bin/activate${NC}"
echo -e "  3. Start the CEO:      ${YELLOW}claude --agent ceo${NC}"
echo -e "  4. Web dashboard:      ${YELLOW}compaas-web${NC}   (opens at http://localhost:8420)"
echo -e "  5. TUI dashboard:      ${YELLOW}compaas-tui${NC}   (in a separate terminal)"
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
    echo "  2) TUI dashboard"
    echo "  3) CEO agent (Claude Code)"
    read -r -p "Choice [1-3, default 1]: " START_MODE
    START_MODE=${START_MODE:-1}

    case "$START_MODE" in
        1)
            echo -e "${GREEN}Starting COMPaaS web dashboard...${NC}"
            ./.venv/bin/compaas-web
            ;;
        2)
            echo -e "${GREEN}Starting COMPaaS TUI dashboard...${NC}"
            ./.venv/bin/compaas-tui
            ;;
        3)
            echo -e "${GREEN}Starting CEO agent...${NC}"
            source .venv/bin/activate
            claude --agent ceo
            ;;
        *)
            echo -e "${YELLOW}Unknown choice. Skipping auto-start.${NC}"
            ;;
    esac
fi
