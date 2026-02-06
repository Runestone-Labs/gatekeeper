#!/usr/bin/env bash
# Runestone Gatekeeper — Quickstart
#
# Prerequisites:
#   Gatekeeper running at http://127.0.0.1:3847 (docker-compose up)
#
# This script walks through all three decision types:
#   1. DENY  — dangerous command blocked by policy
#   2. ALLOW — safe HTTP request executed immediately
#   3. APPROVE — shell command requires human approval

set -euo pipefail

BASE_URL="${GATEKEEPER_URL:-http://127.0.0.1:3847}"

echo "=== Runestone Gatekeeper Quickstart ==="
echo "Target: $BASE_URL"
echo ""

# -------------------------------------------------------
# 1. DENY — rm -rf matches a deny pattern
# -------------------------------------------------------
echo "--- 1. DENY: dangerous command ---"
echo ""

curl -s -X POST "$BASE_URL/tool/shell.exec" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "quickstart-deny-001",
    "actor": {"type": "agent", "name": "quickstart", "role": "openclaw"},
    "args": {"command": "rm -rf /"}
  }' | python3 -m json.tool

echo ""
echo "^ Decision should be 'deny' with TOOL_DENY_PATTERN."
echo ""

# -------------------------------------------------------
# 2. ALLOW — HTTP GET executes immediately
# -------------------------------------------------------
echo "--- 2. ALLOW: safe HTTP request ---"
echo ""

curl -s -X POST "$BASE_URL/tool/http.request" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "quickstart-allow-001",
    "actor": {"type": "agent", "name": "quickstart", "role": "openclaw"},
    "args": {"url": "https://httpbin.org/get", "method": "GET"}
  }' | python3 -m json.tool

echo ""
echo "^ Decision should be 'allow' with result containing httpbin response."
echo ""

# -------------------------------------------------------
# 3. APPROVE — shell command needs human approval
# -------------------------------------------------------
echo "--- 3. APPROVE: shell command requires approval ---"
echo ""

RESPONSE=$(curl -s -X POST "$BASE_URL/tool/shell.exec" \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "quickstart-approve-001",
    "actor": {"type": "agent", "name": "quickstart", "role": "openclaw"},
    "args": {"command": "echo hello"}
  }')

echo "$RESPONSE" | python3 -m json.tool

echo ""
echo "^ Decision should be 'approve'. Check console/Slack for approval links."
echo ""

# If demo mode is on, extract the approve URL and complete the flow
APPROVE_URL=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    url = data.get('approvalRequest', {}).get('approveUrl', '')
    print(url)
except:
    pass
" 2>/dev/null || true)

if [ -n "$APPROVE_URL" ]; then
  echo "Demo mode detected — auto-approving..."
  echo ""
  curl -s "$APPROVE_URL" | python3 -m json.tool
  echo ""
  echo "^ Tool executed after approval. Check data/audit/ for the full trail."
else
  echo "To approve, click the link in the console output or use:"
  echo "  curl -X POST $BASE_URL/approvals/<approval-id>/approve \\"
  echo "    -H 'Authorization: Bearer \$GATEKEEPER_SECRET'"
fi

echo ""
echo "=== Done ==="
echo ""
echo "Next steps:"
echo "  - Edit policy.example.yaml to customize rules"
echo "  - Check data/audit/ for the audit trail"
echo "  - See docs/POLICY_GUIDE.md for policy writing tutorial"
