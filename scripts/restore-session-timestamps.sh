#!/bin/bash
# Restore file system timestamps on JSONL session files based on their internal timestamps
# Uses the last entry's timestamp as the file's mtime

set -e

BATCH_SIZE=${1:-10}
SLEEP_SECONDS=${2:-1}
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude/projects}"

echo "Restoring timestamps for session files in: $CLAUDE_DIR"
echo "Batch size: $BATCH_SIZE, Sleep: ${SLEEP_SECONDS}s between batches"
echo ""

# Find all jsonl files
mapfile -t files < <(find "$CLAUDE_DIR" -name "*.jsonl" -type f 2>/dev/null)

total=${#files[@]}
echo "Found $total session files"
echo ""

if [ "$total" -eq 0 ]; then
    echo "No session files found."
    exit 0
fi

count=0
updated=0
failed=0

for file in "${files[@]}"; do
    # Get timestamp from last entry
    ts=$(tail -1 "$file" 2>/dev/null | jq -r '.timestamp // empty' 2>/dev/null)

    if [ -n "$ts" ]; then
        if touch -d "$ts" "$file" 2>/dev/null; then
            ((updated++))
            echo "[$((count+1))/$total] Updated: $(basename "$(dirname "$file")")/$(basename "$file")"
        else
            ((failed++))
            echo "[$((count+1))/$total] FAILED: $file"
        fi
    else
        ((failed++))
        echo "[$((count+1))/$total] No timestamp found: $file"
    fi

    ((count++))

    # Sleep every BATCH_SIZE files
    if [ $((count % BATCH_SIZE)) -eq 0 ] && [ "$count" -lt "$total" ]; then
        echo "  ... sleeping ${SLEEP_SECONDS}s ..."
        sleep "$SLEEP_SECONDS"
    fi
done

echo ""
echo "Done! Updated: $updated, Failed: $failed, Total: $total"
