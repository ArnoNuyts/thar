/**
 * Debugging Script: Capture and display raw terminal input.
 * Helps identify ANSI escape sequences sent by different terminals.
 */

async function main() {
  console.log("--- Raw Input Capture ---");
  console.log("Press any keys to see their raw byte sequences.");
  console.log("Press Ctrl+C to exit.");
  console.log("------------------------");

  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    for await (const chunk of process.stdin) {
      const bytes = Array.from(chunk as Buffer);
      const s = new TextDecoder().decode(chunk);

      // Replace escape character with a visible marker for debugging
      const printable = s.replace(/\u001b/g, "\\u001b");

      console.log("\nRaw Data:");
      console.log(`  Bytes:  [${bytes.map((b) => b.toString()).join(", ")}]`);
      console.log(
        `  Hex:    [${bytes
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ")}]`,
      );
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
      process.stdin.setRawMode(false);
    } catch (_e) {
      // Ignore error when resetting raw mode
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
