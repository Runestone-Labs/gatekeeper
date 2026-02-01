# Runestone Gatekeeper Demo Recording
# Produces demo.gif and demo.mp4
#
# Prerequisites:
#   brew install vhs
#   npm install
#
# Usage:
#   vhs scripts/demo.tape

Output demo.gif
Output demo.mp4

# Terminal settings
Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 16
Set Width 1200
Set Height 700
Set Padding 20
Set TypingSpeed 50ms

# Theme
Set Theme "Dracula"

# Clear and show title
Type "# Runestone Gatekeeper - AI Agent Safety Layer"
Enter
Sleep 500ms

Type "# Demo: deny → approve → allow"
Enter
Sleep 1s

# Run the demo
Type "npm run demo"
Enter

# Wait for demo to complete
Sleep 12s
