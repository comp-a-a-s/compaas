#!/usr/bin/env bash
set -euo pipefail

# One-command bootstrap installer for COMPaaS.
# Usage:
#   bash <(curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/master/bootstrap.sh)

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

COMPAAS_REPO_URL="${COMPAAS_REPO_URL:-https://github.com/comp-a-a-s/compaas.git}"
COMPAAS_BRANCH="${COMPAAS_BRANCH:-master}"
COMPAAS_INSTALL_DIR="${COMPAAS_INSTALL_DIR:-$HOME/.compaas}"

echo -e "${BLUE}COMPaaS bootstrap installer${NC}"
echo -e "${BLUE}Built by Idan Hen${NC}"
echo -e "${BLUE}Repo:${NC} ${COMPAAS_REPO_URL}"
echo -e "${BLUE}Install dir:${NC} ${COMPAAS_INSTALL_DIR}"
echo ""

if [ -f "./install.sh" ] && [ -f "./pyproject.toml" ]; then
    REPO_DIR="$(pwd)"
    echo -e "${GREEN}Detected existing COMPaaS repo at:${NC} ${REPO_DIR}"
else
    if ! command -v git >/dev/null 2>&1; then
        echo -e "${RED}ERROR:${NC} git is required for bootstrap install."
        exit 1
    fi

    if [ -d "${COMPAAS_INSTALL_DIR}/.git" ]; then
        echo -e "${YELLOW}Updating existing installation...${NC}"
        if ! git -C "${COMPAAS_INSTALL_DIR}" diff --quiet || ! git -C "${COMPAAS_INSTALL_DIR}" diff --cached --quiet; then
            echo -e "${RED}ERROR:${NC} Existing install has local changes in ${COMPAAS_INSTALL_DIR}."
            echo "Please commit/stash them or remove the directory, then rerun bootstrap."
            exit 1
        fi
        git -C "${COMPAAS_INSTALL_DIR}" fetch --depth 1 origin "${COMPAAS_BRANCH}"
        git -C "${COMPAAS_INSTALL_DIR}" checkout -q "${COMPAAS_BRANCH}"
        # Align to the remote branch tip even if local history diverged.
        git -C "${COMPAAS_INSTALL_DIR}" reset --hard "origin/${COMPAAS_BRANCH}" >/dev/null
    else
        echo -e "${YELLOW}Cloning COMPaaS...${NC}"
        rm -rf "${COMPAAS_INSTALL_DIR}"
        git clone --depth 1 --branch "${COMPAAS_BRANCH}" "${COMPAAS_REPO_URL}" "${COMPAAS_INSTALL_DIR}"
    fi
    REPO_DIR="${COMPAAS_INSTALL_DIR}"
fi

echo ""
echo -e "${GREEN}Running installer...${NC}"
cd "${REPO_DIR}"
bash ./install.sh
