#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRAWLER_WORKER_DIR="$SCRIPT_DIR/../crawler-worker"
CRAWLERS_DIR="$CRAWLER_WORKER_DIR/src/crawlers"
GUIDE_PATH="$CRAWLERS_DIR/IMPLEMENTING_A_CRAWLER.md"

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <merchant-name> <iterations>"
  echo "Example: $0 carrefour 10"
  exit 1
fi

MERCHANT_NAME=$1
ITERATIONS=$2
MERCHANT_DIR="$CRAWLERS_DIR/$MERCHANT_NAME"
PRD_PATH="$MERCHANT_DIR/prd.json"
PROGRESS_PATH="$MERCHANT_DIR/progress.txt"

if [ ! -f "$PRD_PATH" ]; then
  echo "Error: PRD not found at $PRD_PATH"
  echo "Run create-crawler.sh first to generate the PRD."
  exit 1
fi

echo "Implementing crawler for: $MERCHANT_NAME"
echo "PRD: $PRD_PATH"
echo "Iterations: $ITERATIONS"
echo ""

for ((i=1; i<=$ITERATIONS; i++)); do
  echo "================================"
  echo "Iteration $i of $ITERATIONS"
  echo "================================"

  result=$(claude --chrome --permission-mode acceptEdits -p "
You are implementing a crawler for $MERCHANT_NAME.

## REFERENCES
- Implementation guide: @$GUIDE_PATH
- PRD with tasks: @$PRD_PATH
- Progress so far: @$PROGRESS_PATH

## YOUR TASK
1. Find the highest-priority task that has \"passes\": false
2. Implement ONLY that task
3. Use Chrome if you need to verify behavior on the live website
4. Run pnpm typecheck and pnpm test to verify your work
5. Update the PRD: set \"passes\": true for completed task
6. Append a note to progress.txt about what you did
7. Make a git commit

ONLY WORK ON A SINGLE TASK PER ITERATION.

If all tasks have \"passes\": true, output <complete>DONE</complete>
")

  echo "$result"

  if [[ "$result" == *"<complete>DONE</complete>"* ]]; then
    echo ""
    echo "================================"
    echo "PRD complete after $i iterations!"
    echo "================================"
    exit 0
  fi
done

echo ""
echo "Reached max iterations ($ITERATIONS). PRD may not be complete."
