# Thar terminal demo — records docs/demo.gif.
#
# Run from the repository root after building the app:
#   npm run build
#   vhs docs/demo.tape
#
# Requires vhs and ttyd on PATH. In headless containers where Chromium cannot
# use its sandbox, run:
#   VHS_NO_SANDBOX=1 vhs docs/demo.tape
#
# The fixture is copied to /tmp/opencode/thar-demo.txt so the demo never
# mutates the tracked file and every recording starts from the same list.

Output docs/demo.gif

Set Shell bash
Set FontFamily "DejaVu Sans Mono"
Set FontSize 18
Set Width 1000
Set Height 600
Set Padding 20
Set Framerate 10
Set TypingSpeed 35ms
Set CursorBlink false
Set Theme { "name": "thar-demo", "black": "#181818", "red": "#CE7768", "green": "#7BA152", "yellow": "#DDB14D", "blue": "#6399C6", "magenta": "#AF76B7", "cyan": "#6399C6", "white": "#EEECE5", "brightBlack": "#676560", "brightRed": "#CE7768", "brightGreen": "#7BA152", "brightYellow": "#DDB14D", "brightBlue": "#6399C6", "brightMagenta": "#AF76B7", "brightCyan": "#6399C6", "brightWhite": "#FFFFFF", "background": "#181818", "foreground": "#EEECE5", "selection": "#AF76B7", "cursor": "#EEECE5" }

# Prepare a disposable copy and launch the built app without showing the shell.
Hide
Type "mkdir -p /tmp/opencode && cp docs/demo.todo.txt /tmp/opencode/thar-demo.txt && clear"
Enter
Sleep 500ms
Type "node dist/main.js /tmp/opencode/thar-demo.txt"
Enter
Sleep 5s

# Ink paints the initial list without a focused row until the first navigation
# event. Nudge the cursor down and back up inside the hidden region so the
# first visible frame already shows the selected todo.
Down
Sleep 400ms
Up
Sleep 400ms
Show

# Let the viewer read the list.
Sleep 2s

# Move the selection down and back up.
Down
Sleep 700ms
Up
Sleep 700ms

# Add a todo. The trailing space prevents the tag suggestions from turning
# Enter into "accept suggestion" instead of "save".
Type "n"
Sleep 800ms
Type "Ship v0.5.0 +release @laptop "
Sleep 800ms
Enter
Sleep 2s

# Complete the newly added todo.
Space
Sleep 2s

# Open the command menu, then dismiss it.
Type "x"
Sleep 2s
Escape
Sleep 800ms

# Filter by "release", then clear the search.
Type "/"
Sleep 600ms
Type "release"
Sleep 2s
Escape
Sleep 1s

# Quit with q without capturing the returning shell prompt.
Hide
Type "q"
Sleep 500ms
