#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

print_header() {
    echo -e "${BLUE}=== $1 ===${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

show_usage() {
    echo "Bitcoin Power Law - Rollback Helper"
    echo ""
    echo "Usage: $0 <command> [options]"
    echo ""
    echo "Commands:"
    echo "  list              List all available rollback versions (tags)"
    echo "  to <tag>          Rollback to a specific version/tag"
    echo "  current           Show the currently checked out version"
    echo "  diff <tag1> <tag2>  Show what changed between two versions"
    echo ""
    echo "Examples:"
    echo "  $0 list"
    echo "  $0 to v2-backend-powered"
    echo "  $0 to legacy-single-file"
    echo "  $0 current"
    echo "  $0 diff legacy-single-file v2-backend-powered"
    echo ""
    echo "Important:"
    echo "  - Always commit or stash your work before rolling back"
    echo "  - After rolling back the frontend, you usually need to rebuild it"
    echo "  - After rolling back data (btc_daily.csv), run: curl -X POST http://localhost:8000/refit"
}

list_versions() {
    print_header "Available Rollback Versions"
    echo ""
    echo "These are the tagged versions you can roll back to:"
    echo ""

    git tag -l | while read -r tag; do
        desc=$(git tag -l --format='%(contents:subject)' "$tag" 2>/dev/null || echo "")
        if [ -z "$desc" ]; then
            desc=$(git log -1 --format=%s "$tag" 2>/dev/null || echo "No description")
        fi
        printf "  ${GREEN}%-28s${NC} %s\n" "$tag" "$desc"
    done

    echo ""
    echo "To rollback to one of these, run:"
    echo "  $0 to <tag-name>"
    echo ""
    echo "Example:"
    echo "  $0 to legacy-single-file     # Go back to the old single-file version"
    echo "  $0 to v2-backend-powered     # Go to current production version"
}

show_current() {
    print_header "Current Version"

    current_commit=$(git rev-parse --short HEAD)
    current_tag=$(git describe --tags --exact-match 2>/dev/null || echo "No exact tag match")

    echo "  Commit:  $current_commit"
    echo "  Tag:     $current_tag"
    echo "  Branch:  $(git branch --show-current)"
    echo ""

    if git describe --tags --exact-match >/dev/null 2>&1; then
        print_success "You are on a tagged release"
    else
        print_warning "You are on an untagged commit (development version)"
    fi
}

rollback_to() {
    local target="$1"

    if [ -z "$target" ]; then
        print_error "No target specified"
        echo "Usage: $0 to <tag>"
        echo ""
        echo "Available tags:"
        git tag -l
        exit 1
    fi

    # Check if tag exists
    if ! git rev-parse --verify "$target" >/dev/null 2>&1; then
        print_error "Tag or commit '$target' does not exist"
        echo ""
        echo "Available tags:"
        git tag -l
        exit 1
    fi

    # Safety check for uncommitted changes
    if ! git diff --quiet || ! git diff --cached --quiet; then
        print_warning "You have uncommitted changes!"
        echo ""
        git status --short
        echo ""
        read -p "Do you want to stash these changes before rolling back? [y/N] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            git stash push -m "Auto-stash before rollback to $target"
            print_success "Changes stashed. You can restore them later with: git stash pop"
        else
            print_error "Rollback cancelled. Please commit or stash your changes first."
            exit 1
        fi
    fi

    print_header "Rolling back to $target"

    git checkout "$target"

    echo ""
    print_success "Successfully checked out $target"

    # Post-rollback guidance
    echo ""
    print_header "Post-Rollback Steps"

    if [[ "$target" == "legacy-single-file" ]]; then
        echo "You are now on the old single-file version."
        echo ""
        echo "To use this version:"
        echo "  • Open index.html directly in a browser, or"
        echo "  • Serve it with any static web server"
        echo ""
        echo "Note: The backend is not used in this version."
    else
        echo "1. If you changed the frontend, rebuild it:"
        echo "   cd frontend && npm run build"
        echo "   cp dist/index.html .."
        echo "   cp dist/assets/* ../assets/"
        echo ""
        echo "2. If you rolled back btc_daily.csv, refit the model:"
        echo "   curl -X POST http://localhost:8000/refit"
        echo ""
        echo "3. Restart the backend if needed:"
        echo "   python backend/run.py"
    fi

    echo ""
    print_warning "To return to the latest version later, run:"
    echo "  git checkout main"
}

show_diff() {
    local from="$1"
    local to="$2"

    if [ -z "$from" ] || [ -z "$to" ]; then
        print_error "Please provide two tags/commits to compare"
        echo "Usage: $0 diff <from> <to>"
        echo ""
        echo "Example:"
        echo "  $0 diff legacy-single-file v2-backend-powered"
        exit 1
    fi

    print_header "Changes from $from → $to"

    git diff --stat "$from" "$to"

    echo ""
    echo "To see the full diff, run:"
    echo "  git diff $from $to"
}

# Main command router
case "$1" in
    list)
        list_versions
        ;;
    to)
        rollback_to "$2"
        ;;
    current)
        show_current
        ;;
    diff)
        show_diff "$2" "$3"
        ;;
    *)
        show_usage
        exit 1
        ;;
esac
