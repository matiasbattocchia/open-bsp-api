#!/usr/bin/env bash
#
# PostToolUse (Edit|Write|MultiEdit) — format + check the edited file with THIS
# repo's CI tools (deno; see .github/workflows/check.yml) so Claude gets
# immediate feedback on its own edits.
#
#   format -> deno fmt          (CI gate: deno fmt --check)
#   lint   -> deno lint <file>  (CI gate: deno lint)
#   types  -> deno check <file> (CI gate: deno check)
#
# Formatting is applied in place. lint/type failures are written to stderr with
# exit 2, which Claude Code feeds back so the error can be fixed in-flow.
# Only acts on files inside this repo ($CLAUDE_PROJECT_DIR) — no cross-repo work.
#
# The import map + deno config live in each package's deno.json (supabase/
# functions, plugin); there is no root deno.json. `deno check` only resolves
# bare specifiers (@supabase/supabase-js, ky, zod, …) when run from inside the
# owning package, so we derive the package from the file path and run the tools
# there. CI does the same: `cd supabase/functions && deno lint && deno check .`.

file=$(jq -r '.tool_input.file_path // empty')
[ -n "$file" ] || exit 0
case "$file" in "$CLAUDE_PROJECT_DIR"/*) ;; *) exit 0 ;; esac
case "$file" in
  *.ts | *.tsx | *.js | *.jsx | *.json | *.jsonc | *.md) ;;
  *) exit 0 ;;
esac

# Owning package (the deno.json that carries the import map + config).
pkg=""
case "$file" in
  "$CLAUDE_PROJECT_DIR"/supabase/functions/*) pkg="$CLAUDE_PROJECT_DIR/supabase/functions" ;;
  "$CLAUDE_PROJECT_DIR"/plugin/*) pkg="$CLAUDE_PROJECT_DIR/plugin" ;;
esac

# Run from the package dir when known so deno discovers its deno.json; fall back
# to the repo root for files outside a package (e.g. top-level Markdown).
cwd="${pkg:-$CLAUDE_PROJECT_DIR}"

(cd "$cwd" && deno fmt "$file") >/dev/null 2>&1 || true

problems=""
case "$file" in
  *.ts | *.tsx | *.js | *.jsx)
    if ! out=$(cd "$cwd" && deno lint "$file" 2>&1); then
      problems+="[deno lint]"$'\n'"$out"$'\n\n'
    fi
    ;;
esac
case "$file" in
  *.ts | *.tsx)
    # Type checking needs the package import map; outside a package it only
    # yields false "not a dependency" errors, so skip it there.
    if [ -n "$pkg" ] && ! out=$(cd "$pkg" && deno check "$file" 2>&1); then
      problems+="[deno check]"$'\n'"$out"$'\n'
    fi
    ;;
esac

if [ -n "$problems" ]; then
  printf '%s' "$problems" >&2
  exit 2
fi
exit 0
