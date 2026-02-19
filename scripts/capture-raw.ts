

/**
 * Debugging Script: Capture and display raw terminal input.
 * Helps identify ANSI escape sequences sent by different terminals.
 */

console.log("--- Raw Input Capture ---");
console.log("Press any keys to see their raw byte sequences.");
console.log("Press Ctrl+C to exit.");
console.log("------------------------");

try {
  Deno.stdin.setRaw(true);

  for await (const chunk of Deno.stdin.readable) {
    const bytes = Array.from(chunk);
    const s = new TextDecoder().decode(chunk);
    
    // Replace escape character with a visible marker for debugging
    // deno-lint-ignore no-control-regex
    const printable = s.replace(/\u001b/g, "\\u001b");

    console.log("\nRaw Data:");
    console.log(`  Bytes:  [${bytes.map(b => b.toString()).join(", ")}]`);
    console.log(`  Hex:    [${bytes.map(b => b.toString(16).padStart(2, "0")).join(" ")}]`);
    console.log(`  String: ${JSON.stringify(s)}`);
    console.log(`  Visual: ${printable}`);

    // Ctrl+C check (byte 3)
    if (bytes.length === 1 && bytes[0] === 3) {
      console.log("\nCtrl+C detected. Exiting...");
      break;
    }
  }
} finally {
  try {
    Deno.stdin.setRaw(false);
  } catch (_e) {
    // Ignore error when resetting raw mode
  }
}
