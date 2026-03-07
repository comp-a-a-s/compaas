#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
#  COMPaaS Installer — Animated TUI
#  Sticky progress bar at bottom, braille spinners, step timeline
# ============================================================================

# -- Colors & styles ---------------------------------------------------------
BOLD='\033[1m'
DIM='\033[2m'
ITALIC='\033[3m'
UNDERLINE='\033[4m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
GRAY='\033[0;90m'
BG_BLUE='\033[44m'
BG_GREEN='\033[42m'
BG_PURPLE='\033[45m'
NC='\033[0m'

# -- Unicode glyphs ----------------------------------------------------------
ICON_CHECK="\xe2\x9c\x94"   # checkmark
ICON_CROSS="\xe2\x9c\x98"   # cross
ICON_ARROW="\xe2\x96\xb6"   # right-pointing triangle
ICON_DOT="\xe2\x97\x8b"     # open circle
ICON_BULLET="\xe2\x97\x8f"  # filled circle
ICON_WARN="\xe2\x9a\xa0"    # warning triangle
BAR_FILL="\xe2\x96\x88"     # full block
BAR_LIGHT="\xe2\x96\x91"    # light shade block
BAR_MED="\xe2\x96\x93"      # dark shade block
SPINNER_FRAMES=( "\xe2\xa0\x8b" "\xe2\xa0\x99" "\xe2\xa0\xb9" "\xe2\xa0\xb8" "\xe2\xa0\xbc" "\xe2\xa0\xb4" "\xe2\xa0\xa6" "\xe2\xa0\xa7" "\xe2\xa0\x87" "\xe2\xa0\x8f" )

# -- Global state ------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGO_PATH="$SCRIPT_DIR/web-dashboard/public/compass-rose.svg"
TOTAL_STEPS=8
CURRENT_STEP=0
CURRENT_STEP_TITLE=""
INSTALL_UI_MODE="plain"
SPINNER_PID=""
SPINNER_ACTIVE=false
LOG_LINES=()
MAX_LOG_LINES=6

STEP_NAMES=(
    ""
    "Checking Python"
    "Checking Node.js"
    "Checking AI CLIs"
    "Python virtual environment"
    "Python dependencies"
    "Building web dashboard"
    "Initializing environment"
    "Running tests"
)
STEP_STATUS=()
for ((i=0; i<=TOTAL_STEPS; i++)); do
    STEP_STATUS[$i]="pending"
done

if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; then
    INSTALL_UI_MODE="tui"
fi

# -- Terminal helpers --------------------------------------------------------
term_cols() {
    local cols=100
    if command -v tput &>/dev/null; then
        cols=$(tput cols 2>/dev/null || echo 100)
    fi
    [ -z "${cols:-}" ] || [ "$cols" -lt 60 ] && cols=60
    echo "$cols"
}

term_rows() {
    local rows=24
    if command -v tput &>/dev/null; then
        rows=$(tput lines 2>/dev/null || echo 24)
    fi
    [ -z "${rows:-}" ] || [ "$rows" -lt 10 ] && rows=24
    echo "$rows"
}

repeat_char() {
    local char="$1" count="$2"
    [ "$count" -le 0 ] && return 0
    printf "%${count}s" "" | tr ' ' "$char"
}

hide_cursor()  { [ "$INSTALL_UI_MODE" = "tui" ] && printf '\033[?25l'; }
show_cursor()  { printf '\033[?25h'; }
save_cursor()  { printf '\033[s'; }
restore_cursor() { printf '\033[u'; }
move_to()      { printf "\033[%d;%dH" "$1" "$2"; }
clear_line()   { printf '\033[2K'; }
clear_to_end() { printf '\033[J'; }

# Reserve bottom 5 lines for the sticky progress bar
STICKY_HEIGHT=5
setup_scroll_region() {
    if [ "$INSTALL_UI_MODE" != "tui" ]; then return; fi
    local rows
    rows="$(term_rows)"
    local scroll_end=$((rows - STICKY_HEIGHT))
    # Set scroll region to top portion only
    printf "\033[1;%dr" "$scroll_end"
    # Move cursor to top of scrollable area
    move_to 1 1
}

teardown_scroll_region() {
    if [ "$INSTALL_UI_MODE" != "tui" ]; then return; fi
    local rows
    rows="$(term_rows)"
    printf "\033[1;%dr" "$rows"
    move_to "$rows" 1
}

# -- Sticky progress bar (bottom of screen) ----------------------------------
render_sticky_bar() {
    if [ "$INSTALL_UI_MODE" != "tui" ]; then return; fi

    local cols rows scroll_end
    cols="$(term_cols)"
    rows="$(term_rows)"
    scroll_end=$((rows - STICKY_HEIGHT))

    save_cursor

    # Disable scroll region temporarily to draw in the reserved area
    printf "\033[1;%dr" "$rows"

    local bar_row=$((scroll_end + 1))
    local pct=0
    [ "$TOTAL_STEPS" -gt 0 ] && pct=$((CURRENT_STEP * 100 / TOTAL_STEPS))

    local bar_width=$((cols - 20))
    [ "$bar_width" -lt 20 ] && bar_width=20
    [ "$bar_width" -gt 80 ] && bar_width=80
    local fill=$((pct * bar_width / 100))
    local empty=$((bar_width - fill))

    # Line 1: separator
    move_to "$bar_row" 1
    clear_line
    printf "${GRAY}"
    repeat_char "-" "$cols"
    printf "${NC}"

    # Line 2: step timeline (compact)
    move_to $((bar_row + 1)) 1
    clear_line
    printf "  "
    local i
    for ((i=1; i<=TOTAL_STEPS; i++)); do
        local status="${STEP_STATUS[$i]:-pending}"
        if [ "$status" = "done" ]; then
            printf "${GREEN}${ICON_CHECK}${NC} "
        elif [ "$status" = "active" ]; then
            printf "${CYAN}${ICON_ARROW}${NC} "
        elif [ "$status" = "skip" ]; then
            printf "${YELLOW}${ICON_WARN}${NC} "
        elif [ "$status" = "fail" ]; then
            printf "${RED}${ICON_CROSS}${NC} "
        else
            printf "${GRAY}${ICON_DOT}${NC} "
        fi
    done

    # Line 3: progress bar
    move_to $((bar_row + 2)) 1
    clear_line
    local bar_str=""
    local j
    for ((j=0; j<fill; j++)); do
        bar_str+="$BAR_FILL"
    done
    for ((j=0; j<empty; j++)); do
        bar_str+="$BAR_LIGHT"
    done

    local label
    if [ "$CURRENT_STEP" -gt 0 ] && [ "$CURRENT_STEP" -le "$TOTAL_STEPS" ]; then
        label="${STEP_NAMES[$CURRENT_STEP]}"
    else
        label="Starting..."
    fi
    printf "  ${CYAN}${BOLD}%3d%%${NC} ${PURPLE}%b${NC}  ${DIM}%s${NC}" "$pct" "$bar_str" "$label"

    # Line 4: step counter
    move_to $((bar_row + 3)) 1
    clear_line
    printf "  ${GRAY}Step ${CURRENT_STEP}/${TOTAL_STEPS}${NC}"
    if [ "$pct" -eq 100 ]; then
        printf "  ${GREEN}${BOLD}Complete!${NC}"
    fi

    # Line 5: blank padding
    move_to $((bar_row + 4)) 1
    clear_line

    # Restore scroll region and cursor
    printf "\033[1;%dr" "$scroll_end"
    restore_cursor
}

# -- Spinner (background process) -------------------------------------------
_spinner_loop() {
    local frame_idx=0
    local num_frames=${#SPINNER_FRAMES[@]}
    while true; do
        printf "\r  ${CYAN}%b${NC} ${DIM}working...${NC} " "${SPINNER_FRAMES[$frame_idx]}"
        frame_idx=$(( (frame_idx + 1) % num_frames ))
        sleep 0.08
    done
}

start_spinner() {
    if [ "$INSTALL_UI_MODE" != "tui" ]; then return; fi
    if [ "$SPINNER_ACTIVE" = true ]; then return; fi
    _spinner_loop &
    SPINNER_PID=$!
    SPINNER_ACTIVE=true
}

stop_spinner() {
    if [ "$SPINNER_ACTIVE" = true ] && [ -n "$SPINNER_PID" ]; then
        kill "$SPINNER_PID" 2>/dev/null || true
        wait "$SPINNER_PID" 2>/dev/null || true
        SPINNER_PID=""
        SPINNER_ACTIVE=false
        printf "\r\033[2K"
    fi
}

# -- Logging (prints above the sticky bar) -----------------------------------
log_info() {
    stop_spinner
    echo -e "  ${BLUE}${ICON_BULLET}${NC}  ${DIM}$*${NC}"
    render_sticky_bar
}

log_ok() {
    stop_spinner
    echo -e "  ${GREEN}${ICON_CHECK}${NC}  $*"
    render_sticky_bar
}

log_warn() {
    stop_spinner
    echo -e "  ${YELLOW}${ICON_WARN}${NC}  ${YELLOW}$*${NC}"
    render_sticky_bar
}

log_error() {
    stop_spinner
    echo -e "  ${RED}${ICON_CROSS}${NC}  ${RED}$*${NC}"
    render_sticky_bar
}

# -- Step lifecycle ----------------------------------------------------------
start_step() {
    local step_num="$1"
    local step_title="$2"
    CURRENT_STEP="$step_num"
    CURRENT_STEP_TITLE="$step_title"
    STEP_STATUS[$step_num]="active"

    if [ "$INSTALL_UI_MODE" = "tui" ]; then
        echo ""
        echo -e "  ${CYAN}${BOLD}${ICON_ARROW} Step ${step_num}/${TOTAL_STEPS}:${NC} ${WHITE}${BOLD}${step_title}${NC}"
        echo -e "  ${GRAY}$(repeat_char "." 50)${NC}"
        render_sticky_bar
    else
        echo -e "${YELLOW}[${step_num}/${TOTAL_STEPS}] ${step_title}...${NC}"
    fi
}

finish_step() {
    stop_spinner
    local status="${1:-done}"
    STEP_STATUS[$CURRENT_STEP]="$status"
    if [ "$INSTALL_UI_MODE" = "tui" ]; then
        if [ "$status" = "done" ]; then
            echo -e "  ${GREEN}${BOLD}${ICON_CHECK} Done${NC}"
        elif [ "$status" = "skip" ]; then
            echo -e "  ${YELLOW}${BOLD}${ICON_WARN} Skipped${NC}"
        else
            echo -e "  ${RED}${BOLD}${ICON_CROSS} Failed${NC}"
        fi
        render_sticky_bar
    fi
}

# -- Banner ------------------------------------------------------------------
print_banner() {
    if [ "$INSTALL_UI_MODE" = "tui" ]; then
        clear 2>/dev/null || true
        hide_cursor
    fi

    if command -v chafa &>/dev/null && [ -f "$LOGO_PATH" ]; then
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
    echo ""
    echo -e "  ${BLUE}${BOLD}COMPaaS Virtual Company${NC}  ${GRAY}|${NC}  ${DIM}Installation${NC}"
    echo -e "  ${GRAY}Built by Idan H.${NC}"
    echo ""
    echo -e "  ${DIM}${TOTAL_STEPS} steps to set up your AI-powered company platform${NC}"
    echo ""

    if [ "$INSTALL_UI_MODE" = "tui" ]; then
        setup_scroll_region
        render_sticky_bar
    fi
}

# -- Cleanup on exit ---------------------------------------------------------
cleanup() {
    stop_spinner
    show_cursor
    teardown_scroll_region
}
trap cleanup EXIT

on_install_error() {
    local exit_code=$?
    stop_spinner
    STEP_STATUS[$CURRENT_STEP]="fail"
    render_sticky_bar
    echo ""
    log_error "Installation failed at step ${CURRENT_STEP}/${TOTAL_STEPS}: ${CURRENT_STEP_TITLE:-unknown}"
    log_warn "Review the output above, fix the issue, and rerun install.sh"
    show_cursor
    teardown_scroll_region
    exit "$exit_code"
}
trap on_install_error ERR

# ============================================================================
#  Utility functions (dependency checks, installers)
# ============================================================================

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
        show_cursor
        read -r -p "  Press Enter to install ${cli_label}, or type 'n' to skip: " INSTALL_NOW
        hide_cursor
    else
        INSTALL_NOW="n"
    fi
    if [[ "${INSTALL_NOW:-}" =~ ^[Nn]$ ]]; then
        log_warn "Skipping ${cli_label} installation"
    else
        start_spinner
        if install_npm_cli_with_fallback "$cli_label" "$cli_bin" "$npm_package"; then
            stop_spinner
            if command -v "$cli_bin" &>/dev/null; then
                log_ok "${cli_label} installed"
            else
                log_warn "${cli_label} installed but command is not available yet. Re-open terminal and retry."
            fi
        else
            stop_spinner
            log_warn "Failed to install ${cli_label}; continuing setup"
        fi
    fi
}

detect_shell_rc_file() {
    local shell_name
    shell_name="$(basename "${SHELL:-}")"
    case "$shell_name" in
        zsh)  echo "$HOME/.zshrc" ;;
        bash)
            if [ -f "$HOME/.bash_profile" ]; then
                echo "$HOME/.bash_profile"
            else
                echo "$HOME/.bashrc"
            fi
            ;;
        *) echo "" ;;
    esac
}

ensure_npm_prefix_on_path() {
    local prefix_dir="$1"
    local path_dir="${prefix_dir}/bin"
    local path_line="export PATH=\"${path_dir}:\$PATH\""
    local shell_rc

    export PATH="${path_dir}:$PATH"
    hash -r

    shell_rc="$(detect_shell_rc_file)"
    if [ -z "$shell_rc" ]; then
        log_info "Add ${path_dir} to your PATH to use npm global CLIs in new terminals."
        return 0
    fi

    touch "$shell_rc" 2>/dev/null || true
    if [ -f "$shell_rc" ] && grep -Fq "$path_line" "$shell_rc"; then
        return 0
    fi

    if [ -f "$shell_rc" ] || touch "$shell_rc" 2>/dev/null; then
        if {
            echo ""
            echo "# Added by COMPaaS installer for npm global tools"
            echo "$path_line"
        } >> "$shell_rc"; then
            log_info "Added ${path_dir} to PATH in ${shell_rc}"
        else
            log_info "Could not update ${shell_rc}. Add ${path_dir} to PATH manually."
        fi
    else
        log_info "Add ${path_dir} to your PATH to use npm global CLIs in new terminals."
    fi
}

install_npm_cli_with_fallback() {
    local cli_label="$1"
    local cli_bin="$2"
    local npm_package="$3"
    local npm_prefix="$HOME/.npm-global"

    if npm install -g "$npm_package"; then
        return 0
    fi

    log_warn "Global npm install failed for ${cli_label}; retrying with user-local npm prefix (${npm_prefix})..."
    if ! mkdir -p "$npm_prefix"; then
        return 1
    fi
    if npm install -g "$npm_package" --prefix "$npm_prefix"; then
        ensure_npm_prefix_on_path "$npm_prefix"
        if command -v "$cli_bin" &>/dev/null; then
            return 0
        fi
        if [ -x "${npm_prefix}/bin/${cli_bin}" ]; then
            log_info "${cli_label} installed at ${npm_prefix}/bin/${cli_bin}"
            return 0
        fi
    fi
    return 1
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

    local candidate version_full version_major version_minor version_patch version_score
    local best_bin="" best_score=-1 best_major=0 best_minor=0

    for candidate in "${candidates[@]}"; do
        [ ! -x "$candidate" ] && continue
        version_full="$("$candidate" -c 'import sys; v=sys.version_info; print(f"{v.major}.{v.minor}.{v.micro}")' 2>/dev/null || true)"
        [[ ! "$version_full" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && continue

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

    [ -z "$best_bin" ] && return 2

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
    command -v node &>/dev/null || return 2
    NODE_VERSION=$(node -v | sed 's/^v//')
    local node_major
    node_major=$(echo "$NODE_VERSION" | cut -d. -f1)
    [ "$node_major" -lt 18 ] && return 3
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
    show_cursor
    read -r -p "  Press Enter to install the latest Node.js (includes npm) and continue to ${reason}, or type 'n' to skip: " install_node_now
    hide_cursor
    if [[ "${install_node_now:-}" =~ ^[Nn]$ ]]; then
        log_warn "Skipping Node.js/npm installation"
        return 1
    fi

    log_info "Installing Node.js..."
    start_spinner
    if ! install_nodejs_auto; then
        stop_spinner
        log_warn "Automatic Node.js installation failed."
        return 1
    fi
    stop_spinner

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
    show_cursor
    read -r -p "  Press Enter to install Ollama now, or type 'n' to skip: " install_ollama_now
    hide_cursor
    if [[ "${install_ollama_now:-}" =~ ^[Nn]$ ]]; then
        log_warn "Skipping Ollama installation"
        return 0
    fi

    log_info "Installing Ollama..."
    start_spinner
    if install_ollama_auto; then
        stop_spinner
        hash -r
        if command -v ollama &>/dev/null; then
            log_ok "Ollama installed"
        else
            log_warn "Ollama installed but not on PATH yet. Re-open terminal if needed."
        fi
    else
        stop_spinner
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
    show_cursor
    read -r -p "  Press Enter to install the latest Python 3 and continue, or type 'n' to cancel: " install_python_now
    hide_cursor
    if [[ "${install_python_now:-}" =~ ^[Nn]$ ]]; then
        log_error "Python installation canceled. Install Python 3.10+ and rerun."
        return 1
    fi

    log_info "Installing Python..."
    start_spinner
    if ! install_python3_auto; then
        stop_spinner
        log_error "Automatic Python installation failed. Install Python manually and rerun."
        return 1
    fi
    stop_spinner

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

# ============================================================================
#  Main installation flow
# ============================================================================

print_banner

# 1. Check Python 3.10+
start_step 1 "Checking Python"
if ! ensure_python_ready; then
    finish_step "fail"
    exit 1
fi
finish_step

# 2. Check Node.js (optional, for web dashboard)
start_step 2 "Checking Node.js"
if ensure_nodejs_ready "web dashboard and CLI tools"; then
    HAS_NODE=true
    finish_step
else
    log_warn "Node.js not found - web dashboard will not be built"
    log_info "Install Node.js 18+ to enable the web dashboard"
    HAS_NODE=false
    finish_step "skip"
fi

# 3. Check optional AI CLIs
start_step 3 "Checking AI CLIs"
offer_cli_install "Claude Code CLI" "claude" "@anthropic-ai/claude-code"
offer_cli_install "Codex CLI" "codex" "@openai/codex"
offer_ollama_install
finish_step

# 4. Create Python virtual environment
start_step 4 "Python virtual environment"
cd "$SCRIPT_DIR"
if [ ! -d ".venv" ]; then
    start_spinner
    "$PYTHON_BIN" -m venv .venv
    stop_spinner
    log_ok "Virtual environment created"
else
    log_ok "Virtual environment already exists"
fi
source .venv/bin/activate
VENV_PYTHON="$SCRIPT_DIR/.venv/bin/python"
VENV_PIP="$SCRIPT_DIR/.venv/bin/pip"
finish_step

# 5. Install Python dependencies
start_step 5 "Python dependencies"
start_spinner
"$VENV_PIP" install -e ".[dev,local-models]" --quiet >/dev/null 2>&1
stop_spinner
log_ok "Python dependencies installed"
finish_step

# 6. Build web dashboard (if Node.js available)
start_step 6 "Building web dashboard"
if [ "$HAS_NODE" = true ] && [ -d "web-dashboard" ]; then
    start_spinner
    cd web-dashboard
    npm install --quiet >/dev/null 2>&1
    npm run build --quiet >/dev/null 2>&1
    cd "$SCRIPT_DIR"
    stop_spinner
    log_ok "Web dashboard built"
    finish_step
else
    log_warn "Skipped (Node.js not available or web-dashboard/ not found)"
    finish_step "skip"
fi

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
TEST_LOG="$(mktemp "${TMPDIR:-/tmp}/compaas-test-log-XXXXXX")"
mkdir -p "$TEST_DATA_DIR" "$TEST_WORKSPACE_DIR"
start_spinner
if COMPAAS_DATA_DIR="$TEST_DATA_DIR" COMPAAS_WORKSPACE_ROOT="$TEST_WORKSPACE_DIR" "$VENV_PYTHON" -m pytest tests/ -q >"$TEST_LOG" 2>&1; then
    stop_spinner
    log_ok "All tests passed"
else
    stop_spinner
    log_error "Some tests failed:"
    cat "$TEST_LOG" 2>/dev/null || true
fi
rm -f "$TEST_LOG"
rm -rf "$TEST_SANDBOX_DIR"
finish_step

# ============================================================================
#  Completion
# ============================================================================

# Mark 100% and do final render
CURRENT_STEP=$TOTAL_STEPS
render_sticky_bar

# Tear down the scroll region so final output prints normally
teardown_scroll_region
show_cursor

echo ""
echo ""
echo -e "  ${PURPLE}${BOLD}$(repeat_char "=" 50)${NC}"
echo -e "  ${GREEN}${BOLD}"
cat << 'DONE_ART'
   ___ ___  __  __ ___ _    ___ _____ ___
  / __/ _ \|  \/  | _ \ |  | __|_   _| __|
 | (_| (_) | |\/| |  _/ |__| _|  | | | _|
  \___\___/|_|  |_|_| |____|___| |_| |___|
DONE_ART
echo -e "${NC}"
echo -e "  ${PURPLE}${BOLD}$(repeat_char "=" 50)${NC}"
echo -e "  ${GRAY}Built by Idan H.${NC}"
echo ""
echo -e "  ${WHITE}${BOLD}Getting started:${NC}"
echo ""
echo -e "    ${CYAN}1.${NC} Activate venv:      ${YELLOW}source .venv/bin/activate${NC}"
echo -e "    ${CYAN}2.${NC} Start dashboard:    ${YELLOW}compaas-web${NC}   ${DIM}(opens at http://localhost:8420)${NC}"
echo -e "    ${CYAN}3.${NC} Run setup wizard:   ${DIM}Choose provider (Anthropic / OpenAI / local Ollama)${NC}"
echo ""

if [ -t 0 ]; then
    echo -e "  ${WHITE}${BOLD}Launch now?${NC}"
    echo ""
    echo -e "    ${CYAN}1${NC})  Web dashboard ${GREEN}(recommended)${NC}"
    echo -e "    ${CYAN}2${NC})  API server only ${DIM}(no browser auto-open)${NC}"
    echo -e "    ${CYAN}q${NC})  Exit installer"
    echo ""
    read -r -p "  Choice [1/2/q, default 1]: " START_MODE
    START_MODE=${START_MODE:-1}

    case "$START_MODE" in
        1)
            echo ""
            echo -e "  ${GREEN}${ICON_ARROW} Starting COMPaaS web dashboard...${NC}"
            echo ""
            ./.venv/bin/compaas-web
            ;;
        2)
            echo ""
            echo -e "  ${GREEN}${ICON_ARROW} Starting COMPaaS API server (headless)...${NC}"
            echo ""
            COMPAAS_NO_BROWSER=true ./.venv/bin/compaas-web
            ;;
        *)
            echo ""
            echo -e "  ${DIM}Exiting installer. Run ${YELLOW}compaas-web${NC}${DIM} when ready.${NC}"
            ;;
    esac
else
    echo -e "  ${YELLOW}Non-interactive shell detected. Skipping auto-start.${NC}"
fi
