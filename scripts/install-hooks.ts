import { install } from "jsr:@theswanfactory/deno-hooks";

console.log("Installing Deno Git hooks...");
await install();
console.log("Deno Git hooks installed successfully.");
