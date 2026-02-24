#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
#  COMPaaS DMG Builder for macOS
#
#  Creates a distributable .dmg disk image that contains:
#    - The full COMPaaS source tree (excluding dev artifacts)
#    - An "Install COMPaaS.command" double-clickable launcher
#    - A styled DMG with background and icon layout
#
#  Usage:
#    ./scripts/build-dmg.sh [--version X.Y.Z]
#
#  Requirements:
#    - macOS (uses hdiutil, osascript)
#    - Optional: create-dmg (brew install create-dmg) for styled output
#
#  How it works:
#    1. Stages a clean copy of the project into a temp directory
#    2. Creates a .command launcher that opens Terminal and runs install.sh
#    3. Packages everything into a compressed .dmg
#
#  The user experience:
#    - User downloads COMPaaS-X.Y.Z.dmg
#    - Double-clicks to mount
#    - Double-clicks "Install COMPaaS.command"
#    - Terminal opens, runs the animated installer TUI
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# -- Parse arguments ---------------------------------------------------------
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    # Try to extract version from pyproject.toml
    if [ -f "$PROJECT_ROOT/pyproject.toml" ]; then
        VERSION=$(grep -m1 '^version' "$PROJECT_ROOT/pyproject.toml" | sed 's/.*= *"\(.*\)"/\1/' || echo "0.0.0")
    fi
    VERSION="${VERSION:-0.0.0}"
fi
if [[ "$VERSION" == "--version" ]]; then
    VERSION="${2:-0.0.0}"
fi

APP_NAME="COMPaaS"
DMG_NAME="${APP_NAME}-${VERSION}"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/compaas-dmg-XXXXXX")"
APP_DIR="${STAGING_DIR}/${APP_NAME}"
DMG_OUTPUT="${PROJECT_ROOT}/dist/${DMG_NAME}.dmg"

echo ""
echo "  Building ${DMG_NAME}.dmg ..."
echo "  Staging directory: ${STAGING_DIR}"
echo ""

# -- Check platform ----------------------------------------------------------
if [ "$(uname -s)" != "Darwin" ]; then
    echo "ERROR: DMG creation requires macOS (hdiutil)."
    echo ""
    echo "For non-macOS distribution, consider:"
    echo "  - Linux: tar.gz archive (tar czf compaas-${VERSION}.tar.gz ...)"
    echo "  - Windows: zip archive or NSIS installer"
    echo ""
    echo "Creating a portable .tar.gz instead..."

    mkdir -p "$PROJECT_ROOT/dist"
    TAR_OUTPUT="${PROJECT_ROOT}/dist/${DMG_NAME}.tar.gz"

    tar czf "$TAR_OUTPUT" \
        --exclude='.venv' \
        --exclude='node_modules' \
        --exclude='__pycache__' \
        --exclude='.git' \
        --exclude='dist' \
        --exclude='*.egg-info' \
        --exclude='.env' \
        -C "$PROJECT_ROOT/.." \
        "$(basename "$PROJECT_ROOT")"

    echo "  Created: ${TAR_OUTPUT}"
    echo "  Users can extract and run: ./install.sh"
    exit 0
fi

# -- Stage the project -------------------------------------------------------
mkdir -p "$APP_DIR"

# Copy project files, excluding dev/build artifacts
rsync -a \
    --exclude='.venv' \
    --exclude='node_modules' \
    --exclude='__pycache__' \
    --exclude='.git' \
    --exclude='dist' \
    --exclude='*.egg-info' \
    --exclude='.env' \
    --exclude='.mypy_cache' \
    --exclude='.pytest_cache' \
    --exclude='*.pyc' \
    --exclude='.DS_Store' \
    "$PROJECT_ROOT/" "$APP_DIR/"

# -- Create the double-clickable launcher ------------------------------------
# .command files open in Terminal.app when double-clicked on macOS
cat > "${STAGING_DIR}/Install ${APP_NAME}.command" << 'LAUNCHER'
#!/usr/bin/env bash

# COMPaaS Installer Launcher
# This file opens Terminal and runs the COMPaaS installer.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${SCRIPT_DIR}/COMPaaS"

# Determine install location
INSTALL_DIR="$HOME/COMPaaS"

echo ""
echo "  COMPaaS Installer"
echo "  =================="
echo ""

if [ -d "$INSTALL_DIR" ]; then
    echo "  Existing installation found at: $INSTALL_DIR"
    read -r -p "  Overwrite? [y/N]: " OVERWRITE
    if [[ ! "${OVERWRITE:-}" =~ ^[Yy]$ ]]; then
        echo "  Installation canceled."
        echo "  Press any key to close..."
        read -n1 -s
        exit 0
    fi
    rm -rf "$INSTALL_DIR"
fi

echo "  Copying COMPaaS to ${INSTALL_DIR}..."
cp -R "$APP_DIR" "$INSTALL_DIR"
cd "$INSTALL_DIR"

echo "  Starting installer..."
echo ""
bash install.sh

echo ""
echo "  Press any key to close this window..."
read -n1 -s
LAUNCHER

chmod +x "${STAGING_DIR}/Install ${APP_NAME}.command"

# -- Create a README in the DMG root -----------------------------------------
cat > "${STAGING_DIR}/README.txt" << 'README'
COMPaaS - AI-Powered Virtual Company Platform
==============================================

To install:
  1. Double-click "Install COMPaaS.command"
  2. Terminal will open and guide you through setup
  3. Follow the prompts in the installer

Requirements:
  - macOS 12+ (Monterey or later)
  - Python 3.10+ (installer will help set this up)
  - Node.js 18+ (optional, for web dashboard)

The installer will set up COMPaaS in ~/COMPaaS.

Built by Idan H.
README

# -- Build the DMG -----------------------------------------------------------
mkdir -p "$PROJECT_ROOT/dist"

# Remove old DMG if exists
rm -f "$DMG_OUTPUT"

if command -v create-dmg &>/dev/null; then
    # Use create-dmg for a styled DMG with icon layout
    create-dmg \
        --volname "${APP_NAME} ${VERSION}" \
        --volicon "${PROJECT_ROOT}/web-dashboard/public/favicon.ico" 2>/dev/null \
        --window-pos 200 120 \
        --window-size 600 400 \
        --icon-size 80 \
        --icon "Install ${APP_NAME}.command" 175 190 \
        --icon "README.txt" 425 190 \
        --hide-extension "Install ${APP_NAME}.command" \
        --app-drop-link 425 190 2>/dev/null \
        --no-internet-enable \
        "$DMG_OUTPUT" \
        "$STAGING_DIR" \
    || {
        # Fallback: create-dmg can fail on icon/layout issues; use hdiutil
        echo "  create-dmg styling failed, falling back to hdiutil..."
        hdiutil create \
            -volname "${APP_NAME} ${VERSION}" \
            -srcfolder "$STAGING_DIR" \
            -ov \
            -format UDZO \
            "$DMG_OUTPUT"
    }
else
    # Fallback: plain hdiutil (always available on macOS)
    hdiutil create \
        -volname "${APP_NAME} ${VERSION}" \
        -srcfolder "$STAGING_DIR" \
        -ov \
        -format UDZO \
        "$DMG_OUTPUT"
fi

# -- Cleanup -----------------------------------------------------------------
rm -rf "$STAGING_DIR"

# -- Report ------------------------------------------------------------------
DMG_SIZE=$(du -sh "$DMG_OUTPUT" | cut -f1)
echo ""
echo "  DMG created successfully!"
echo ""
echo "  Output:  ${DMG_OUTPUT}"
echo "  Size:    ${DMG_SIZE}"
echo "  Version: ${VERSION}"
echo ""
echo "  To test:"
echo "    open ${DMG_OUTPUT}"
echo ""
