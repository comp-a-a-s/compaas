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
TOTAL_STEPS=8
CURRENT_STEP=0
CURRENT_STEP_TITLE=""
INSTALL_UI_MODE="plain"

if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; then
    INSTALL_UI_MODE="tui"
fi

term_cols() {
    local cols=100
    if command -v tput &>/dev/null; then
        cols=$(tput cols 2>/dev/null || echo 100)
    fi
    if [ -z "${cols:-}" ] || [ "$cols" -lt 60 ]; then
        cols=60
    fi
    echo "$cols"
}

repeat_char() {
    local char="$1"
    local count="$2"
    if [ "$count" -le 0 ]; then
        return 0
    fi
    printf "%${count}s" "" | tr ' ' "$char"
}

fit_text() {
    local text="$1"
    local width="$2"
    local len="${#text}"
    if [ "$len" -le "$width" ]; then
        printf "%s" "$text"
    elif [ "$width" -gt 3 ]; then
        printf "%s..." "${text:0:$((width - 3))}"
    else
        printf "%s" "${text:0:$width}"
    fi
}

log_info() {
    echo -e "${BLUE}  [INFO] $*${NC}"
}

log_ok() {
    echo -e "${GREEN}  [OK]   $*${NC}"
}

log_warn() {
    echo -e "${YELLOW}  [WARN] $*${NC}"
}

log_error() {
    echo -e "${RED}  [ERR]  $*${NC}"
}

render_step_panel() {
    local title="$1"
    if [ "$INSTALL_UI_MODE" != "tui" ]; then
        echo -e "${YELLOW}[${CURRENT_STEP}/${TOTAL_STEPS}] ${title}...${NC}"
        return
    fi

    local cols
    cols="$(term_cols)"
    if [ "$cols" -gt 110 ]; then
        cols=110
    fi

    local inner_width=$((cols - 2))
    local body_width=$((cols - 4))
    local bar_width=$((body_width - 24))
    if [ "$bar_width" -lt 10 ]; then
        bar_width=10
    fi

    local pct=$((CURRENT_STEP * 100 / TOTAL_STEPS))
    local fill=$((CURRENT_STEP * bar_width / TOTAL_STEPS))
    local empty=$((bar_width - fill))
    local step_text="Step ${CURRENT_STEP}/${TOTAL_STEPS}: ${title}"
    local progress_text="Progress: [$(repeat_char "#" "$fill")$(repeat_char "-" "$empty")] ${pct}%"

    echo ""
    echo -e "${BLUE}+$(repeat_char "-" "$inner_width")+${NC}"
    printf "${BLUE}|${NC} %-*s ${BLUE}|${NC}\n" "$body_width" "$(fit_text "$step_text" "$body_width")"
    printf "${BLUE}|${NC} %-*s ${BLUE}|${NC}\n" "$body_width" "$(fit_text "$progress_text" "$body_width")"
    echo -e "${BLUE}+$(repeat_char "-" "$inner_width")+${NC}"
}

start_step() {
    CURRENT_STEP="$1"
    CURRENT_STEP_TITLE="$2"
    render_step_panel "$CURRENT_STEP_TITLE"
}

finish_step() {
    if [ "$INSTALL_UI_MODE" = "tui" ]; then
        log_ok "Completed: ${CURRENT_STEP_TITLE}"
    fi
}

print_banner() {
    if [ "$INSTALL_UI_MODE" = "tui" ]; then
        clear 2>/dev/null || true
        echo -e "${GREEN}Running installer...${NC}"
        echo ""
    fi

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

on_install_error() {
    local exit_code=$?
    echo ""
    log_error "Installation failed at step ${CURRENT_STEP}/${TOTAL_STEPS}: ${CURRENT_STEP_TITLE:-unknown}"
    log_warn "Review the output above, fix the issue, and rerun install.sh."
    exit "$exit_code"
}
trap on_install_error ERR

offer_cli_install() {
    local cli_label="$1"
    local cli_bin="$2"
    local npm_package="$3"

    if command -v "$cli_bin" &>/dev/null; then
        log_ok "${cli_label} found"
        return 0
    fi

    log_warn "${cli_label} not found"
    log_info "Required for ${cli_label} provider mode"
    log_info "Install command: npm install -g ${npm_package}"

    if ! command -v npm &>/dev/null; then
        log_warn "npm is unavailable. Node.js (with npm) is required first."
        if ! ensure_nodejs_ready "install ${cli_label}"; then
            log_warn "Skipping ${cli_label} installation (npm unavailable)."
            return 0
        fi
    fi

    if [ -t 0 ]; then
        read -r -p "  Press Enter to install ${cli_label}, or type 'n' to skip: " INSTALL_NOW
    else
        INSTALL_NOW="n"
    fi
    if [[ "${INSTALL_NOW:-}" =~ ^[Nn]$ ]]; then
        log_warn "Skipping ${cli_label} installation"
    else
        if npm install -g "$npm_package"; then
            if command -v "$cli_bin" &>/dev/null; then
                log_ok "${cli_label} installed"
            else
                log_warn "${cli_label} installed but command is not available yet. Re-open terminal and retry."
            fi
        else
            log_warn "Failed to install ${cli_label}; continuing setup"
        fi
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
    log_error "sudo is required to auto-install this dependency."
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

pick_best_python3() {
    local candidates=()
    local path_candidate

    if command -v python3 &>/dev/null; then
        candidates+=("$(command -v python3)")
    fi
    if [ -x /opt/homebrew/bin/python3 ]; then
        candidates+=("/opt/homebrew/bin/python3")
    fi
    if [ -x /usr/local/bin/python3 ]; then
        candidates+=("/usr/local/bin/python3")
    fi

    while IFS= read -r path_candidate; do
        candidates+=("$path_candidate")
    done < <(ls -1 /Library/Frameworks/Python.framework/Versions/*/bin/python3 2>/dev/null || true)

    local candidate
    local version_full
    local version_major
    local version_minor
    local version_patch
    local version_score
    local best_bin=""
    local best_score=-1
    local best_major=0
    local best_minor=0

    for candidate in "${candidates[@]}"; do
        if [ ! -x "$candidate" ]; then
            continue
        fi

        version_full="$("$candidate" -c 'import sys; v=sys.version_info; print(f"{v.major}.{v.minor}.{v.micro}")' 2>/dev/null || true)"
        if [[ ! "$version_full" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            continue
        fi

        IFS='.' read -r version_major version_minor version_patch <<< "$version_full"
        version_score=$((version_major * 1000000 + version_minor * 1000 + version_patch))
        if [ "$version_score" -gt "$best_score" ]; then
            best_score="$version_score"
            best_bin="$candidate"
            best_major="$version_major"
            best_minor="$version_minor"
            PY_VERSION="${version_major}.${version_minor}"
        fi
    done

    if [ -z "$best_bin" ]; then
        return 2
    fi

    PYTHON_BIN="$best_bin"
    export PYTHON_BIN

    if [ "$best_major" -lt 3 ] || ([ "$best_major" -eq 3 ] && [ "$best_minor" -lt 10 ]); then
        return 3
    fi
    return 0
}

install_python3_auto() {
    local os_name
    os_name="$(uname -s)"

    if [ "$os_name" = "Darwin" ]; then
        if ! command -v brew &>/dev/null; then
            log_warn "Homebrew not found. Installing Homebrew first..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            refresh_homebrew_shellenv || true
        fi

        if ! command -v brew &>/dev/null; then
            log_error "Homebrew installation failed; cannot auto-install Python."
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

    log_error "Unsupported OS/package manager for automatic Python installation."
    return 1
}

install_nodejs_auto() {
    local os_name
    os_name="$(uname -s)"

    if [ "$os_name" = "Darwin" ]; then
        if ! command -v brew &>/dev/null; then
            log_warn "Homebrew not found. Installing Homebrew first..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            refresh_homebrew_shellenv || true
        fi

        if ! command -v brew &>/dev/null; then
            log_error "Homebrew installation failed; cannot auto-install Node.js."
            return 1
        fi

        brew install node
        return $?
    fi

    if command -v apt-get &>/dev/null; then
        run_with_privilege apt-get update
        run_with_privilege apt-get install -y nodejs npm
        return $?
    fi
    if command -v dnf &>/dev/null; then
        run_with_privilege dnf install -y nodejs npm
        return $?
    fi
    if command -v yum &>/dev/null; then
        run_with_privilege yum install -y nodejs npm
        return $?
    fi
    if command -v pacman &>/dev/null; then
        run_with_privilege pacman -Sy --noconfirm nodejs npm
        return $?
    fi
    if command -v zypper &>/dev/null; then
        run_with_privilege zypper --non-interactive install nodejs npm
        return $?
    fi
    if command -v apk &>/dev/null; then
        run_with_privilege apk add --no-cache nodejs npm
        return $?
    fi

    log_error "Unsupported OS/package manager for automatic Node.js installation."
    return 1
}

check_node_version() {
    if ! command -v node &>/dev/null; then
        return 2
    fi

    NODE_VERSION=$(node -v | sed 's/^v//')
    local node_major
    node_major=$(echo "$NODE_VERSION" | cut -d. -f1)

    if [ "$node_major" -lt 18 ]; then
        return 3
    fi
    return 0
}

ensure_nodejs_ready() {
    local reason="${1:-continue}"
    local status
    if check_node_version && command -v npm &>/dev/null; then
        local node_display npm_display
        node_display=$(node -v 2>/dev/null || echo "v$NODE_VERSION")
        npm_display=$(npm -v 2>/dev/null || echo "unknown")
        log_ok "Node.js ${node_display}"
        log_ok "npm ${npm_display}"
        return 0
    fi
    status=$?

    if [ "$status" -eq 2 ]; then
        log_warn "Node.js/npm are not installed."
    elif [ "$status" -eq 3 ]; then
        log_warn "Node.js 18+ is required (found v${NODE_VERSION})."
    else
        log_warn "npm is not installed."
    fi

    if [ ! -t 0 ]; then
        log_warn "Non-interactive mode: cannot auto-install Node.js/npm for ${reason}."
        return 1
    fi

    local install_node_now
    read -r -p "  Press Enter to install the latest Node.js (includes npm) and continue to ${reason}, or type 'n' to skip: " install_node_now
    if [[ "${install_node_now:-}" =~ ^[Nn]$ ]]; then
        log_warn "Skipping Node.js/npm installation"
        return 1
    fi

    log_info "Installing Node.js..."
    if ! install_nodejs_auto; then
        log_warn "Automatic Node.js installation failed."
        return 1
    fi

    refresh_homebrew_shellenv || true
    hash -r

    if ! check_node_version || ! command -v npm &>/dev/null; then
        log_warn "Node.js/npm still unavailable after install. Restart terminal and rerun install.sh."
        return 1
    fi

    local node_display npm_display
    node_display=$(node -v 2>/dev/null || echo "v$NODE_VERSION")
    npm_display=$(npm -v 2>/dev/null || echo "unknown")
    log_ok "Node.js ${node_display}"
    log_ok "npm ${npm_display}"
    return 0
}

install_ollama_auto() {
    local os_name
    os_name="$(uname -s)"

    if [ "$os_name" = "Darwin" ]; then
        if ! command -v brew &>/dev/null; then
            log_warn "Homebrew not found. Installing Homebrew first..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            refresh_homebrew_shellenv || true
        fi
        if ! command -v brew &>/dev/null; then
            log_error "Homebrew installation failed; cannot auto-install Ollama."
            return 1
        fi
        brew install --cask ollama
        return $?
    fi

    if command -v curl &>/dev/null; then
        curl -fsSL https://ollama.com/install.sh | sh
        return $?
    fi

    log_error "curl is required to auto-install Ollama."
    return 1
}

offer_ollama_install() {
    if command -v ollama &>/dev/null; then
        log_ok "Ollama found"
        return 0
    fi

    log_warn "Ollama not found (optional for local model mode)"
    log_info "Install source: https://ollama.com/download"

    if [ ! -t 0 ]; then
        log_warn "Non-interactive mode: skipping Ollama auto-install."
        return 0
    fi

    local install_ollama_now
    read -r -p "  Press Enter to install Ollama now, or type 'n' to skip: " install_ollama_now
    if [[ "${install_ollama_now:-}" =~ ^[Nn]$ ]]; then
        log_warn "Skipping Ollama installation"
        return 0
    fi

    log_info "Installing Ollama..."
    if install_ollama_auto; then
        hash -r
        if command -v ollama &>/dev/null; then
            log_ok "Ollama installed"
        else
            log_warn "Ollama installed but not on PATH yet. Re-open terminal if needed."
        fi
    else
        log_warn "Failed to install Ollama; continuing setup"
    fi
}

check_python_version() {
    pick_best_python3
}

ensure_python_ready() {
    local status
    refresh_homebrew_shellenv || true
    if check_python_version; then
        log_ok "Python ${PY_VERSION} (${PYTHON_BIN})"
        return 0
    fi
    status=$?

    if [ "$status" -eq 2 ]; then
        log_warn "Python 3 is not installed."
    else
        log_warn "Python 3.10+ is required (found ${PY_VERSION} at ${PYTHON_BIN:-unknown path})."
    fi

    if [ ! -t 0 ]; then
        log_error "Non-interactive mode cannot auto-install Python. Install Python 3.10+ and rerun."
        return 1
    fi

    local install_python_now
    read -r -p "  Press Enter to install the latest Python 3 and continue, or type 'n' to cancel: " install_python_now
    if [[ "${install_python_now:-}" =~ ^[Nn]$ ]]; then
        log_error "Python installation canceled. Install Python 3.10+ and rerun."
        return 1
    fi

    log_info "Installing Python..."
    if ! install_python3_auto; then
        log_error "Automatic Python installation failed. Install Python manually and rerun."
        return 1
    fi

    refresh_homebrew_shellenv || true
    hash -r

    if ! check_python_version; then
        log_error "Python 3.10+ is still unavailable after installation."
        log_warn "Please restart your terminal (if needed), then rerun install.sh."
        return 1
    fi

    log_ok "Python ${PY_VERSION} (${PYTHON_BIN})"
    return 0
}

# 1. Check Python 3.10+
start_step 1 "Checking Python"
if ! ensure_python_ready; then
    exit 1
fi
finish_step

# 2. Check Node.js (optional, for web dashboard)
start_step 2 "Checking Node.js (optional, for web dashboard)"
if ensure_nodejs_ready "web dashboard and CLI tools"; then
    HAS_NODE=true
else
    log_warn "Node.js not found - web dashboard will not be built"
    log_info "Install Node.js 18+ to enable the web dashboard"
    HAS_NODE=false
fi
finish_step

# 3. Check optional AI CLIs
start_step 3 "Checking AI runtime CLIs (optional)"
offer_cli_install "Claude Code CLI" "claude" "@anthropic-ai/claude-code"
offer_cli_install "Codex CLI" "codex" "@openai/codex"
offer_ollama_install
finish_step

# 4. Create Python virtual environment
start_step 4 "Setting up Python virtual environment"
cd "$SCRIPT_DIR"
if [ ! -d ".venv" ]; then
    "$PYTHON_BIN" -m venv .venv
    log_ok "Virtual environment created"
else
    log_ok "Virtual environment already exists"
fi
source .venv/bin/activate
finish_step

# 5. Install Python dependencies
start_step 5 "Installing Python dependencies"
pip3 install -e ".[dev,local-models]" --quiet
log_ok "Python dependencies installed"
finish_step

# 6. Build web dashboard (if Node.js available)
start_step 6 "Building web dashboard"
if [ "$HAS_NODE" = true ] && [ -d "web-dashboard" ]; then
    cd web-dashboard
    npm install --quiet 2>/dev/null
    npm run build --quiet 2>/dev/null
    cd "$SCRIPT_DIR"
    log_ok "Web dashboard built"
else
    log_warn "Skipped (Node.js not available or web-dashboard/ not found)"
fi
finish_step

# 7. Initialize directories and environment
start_step 7 "Initializing environment"
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
    log_warn "Created .env file - set provider keys if you use cloud models"
else
    log_ok ".env already exists"
fi

# Make hooks executable
chmod +x scripts/hooks/*.sh 2>/dev/null || true
log_ok "Hooks made executable"
finish_step

# 8. Run tests
start_step 8 "Running tests"
TEST_SANDBOX_DIR="$(mktemp -d "${TMPDIR:-/tmp}/compaas-install-tests-XXXXXX")"
TEST_DATA_DIR="$TEST_SANDBOX_DIR/company_data"
TEST_WORKSPACE_DIR="$TEST_SANDBOX_DIR/projects"
mkdir -p "$TEST_DATA_DIR" "$TEST_WORKSPACE_DIR"
if COMPAAS_DATA_DIR="$TEST_DATA_DIR" COMPAAS_WORKSPACE_ROOT="$TEST_WORKSPACE_DIR" "$PYTHON_BIN" -m pytest tests/ -q 2>/dev/null; then
    log_ok "All tests passed"
else
    log_error "Some tests failed - check output above"
fi
rm -rf "$TEST_SANDBOX_DIR"
finish_step

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
