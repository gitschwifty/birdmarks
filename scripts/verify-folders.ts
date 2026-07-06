// One-shot verification for the BookmarkFoldersSlice GraphQL call.
//
// Reads AUTH_TOKEN and CT0 from the environment (or a local .env file),
// calls only getCurrentUser() and getBookmarkFolders(), prints the result,
// and exits. Nothing is written to disk.
//
// Usage:
//   1. Open https://x.com in a logged-in Chrome session
//   2. DevTools → Application → Cookies → x.com
//   3. Copy the values of:
//        auth_token  →  AUTH_TOKEN
//        ct0         →  CT0
//   4. Save to .env in the project root (already gitignored):
//        AUTH_TOKEN=...
//        CT0=...
//   5. Run with EITHER:
//        node --env-file=.env scripts/verify-folders.ts    (node 24+)
//        bun run scripts/verify-folders.ts                  (if bun installed)
//
// Or pass the tokens inline:
//   AUTH_TOKEN=... CT0=... node scripts/verify-folders.ts
//
// Note: ct0 rotates every few hours. If you get an auth failure, re-grab it.

// Explicit .ts extension so node's native TS runner can resolve this import.
// (Bun resolves both forms; node 24+ requires the extension.)
import { BirdmarksTwitterClient } from "../src/folders-client.ts";

const authToken = process.env.AUTH_TOKEN;
const ct0 = process.env.CT0;

if (!authToken || !ct0) {
  console.error("❌ AUTH_TOKEN and CT0 environment variables are required.");
  console.error("   See the header comment in this file for how to obtain them.");
  process.exit(1);
}

// Sanity check shapes — typo-catching, not validation
if (authToken.length < 30) {
  console.error(`⚠  AUTH_TOKEN looks short (${authToken.length} chars). Twitter auth_token cookies are ~40 hex chars.`);
}
if (ct0.length < 30) {
  console.error(`⚠  CT0 looks short (${ct0.length} chars). Twitter ct0 cookies are typically 32+ chars.`);
}

const client = new BirdmarksTwitterClient({
  cookies: {
    authToken,
    ct0,
    cookieHeader: null,
    source: "env",
  },
});

// Step 1: verify auth works at all
console.log("→ Verifying authentication (getCurrentUser)...");
let me;
try {
  me = await client.getCurrentUser();
} catch (e) {
  console.error(`❌ getCurrentUser threw: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

if (!me.success || !me.user) {
  console.error(`❌ getCurrentUser failed: ${me.error ?? "unknown"}`);
  console.error("   Most likely: AUTH_TOKEN or CT0 is stale. Re-grab them from your browser.");
  process.exit(1);
}
console.log(`   ✓ Logged in as @${me.user.username} (${me.user.name})`);
console.log("");

// Step 2: the actual test — list folders
console.log("→ Calling BookmarkFoldersSlice (getBookmarkFolders)...");
let folders;
try {
  folders = await client.getBookmarkFolders();
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`❌ getBookmarkFolders threw: ${msg}`);

  if (msg.includes("HTTP 401") || msg.includes("HTTP 403")) {
    console.error("");
    console.error("   Auth was accepted for getCurrentUser but rejected for BookmarkFoldersSlice.");
    console.error("   This typically means: feature flags out of date, or your account lacks");
    console.error("   the entitlement for this endpoint (X Premium).");
  } else if (msg.includes("HTTP 404")) {
    console.error("");
    console.error("   The query ID for BookmarkFoldersSlice has rotated.");
    console.error("   See the header comment in src/folders-client.ts for refresh instructions.");
  } else if (msg.includes("HTTP 429") || msg.includes("rate") || msg.includes("Too Many")) {
    console.error("");
    console.error("   Rate limited. Wait a few minutes and re-run.");
  } else if (msg.includes("cannot be null") || msg.includes("features")) {
    console.error("");
    console.error("   Feature flags rejected by X. Open DevTools on https://x.com/i/bookmarks,");
    console.error("   inspect the live BookmarkFoldersSlice request, and copy the `features`");
    console.error("   query param into BOOKMARK_FOLDERS_FEATURES in src/folders-client.ts.");
  }
  process.exit(1);
}

console.log("");
if (folders.length === 0) {
  console.log("⚠  Extractor found no folders in the response.");
  console.log("   Fetching raw response so we can see the actual shape...");
  console.log("");

  try {
    const raw = await client.getBookmarkFoldersRaw();
    // Dump a snapshot so we can adjust extractFoldersFromResponse. Print
    // structure (keys) summary first, then the full JSON.
    console.log("── Response structure (top-level keys) ──");
    summarizeKeys(raw, "");
    console.log("");
    console.log("── Full response JSON ──");
    console.log(JSON.stringify(raw, null, 2));
    console.log("");
    console.log("Paste the JSON above into the chat so I can fix the extractor.");
  } catch (e) {
    console.error(`Could not fetch raw response: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(0);
}

console.log(`✓ Found ${folders.length} folder(s):`);
for (const f of folders) {
  console.log(`   • ${f.name}  (id: ${f.id})`);
}
console.log("");
console.log("Looks good! Run with --with-folders next:");
console.log("   bun run src/index.ts --with-folders --max-pages 1");

// Print a compact summary of object structure: keys at each level, plus
// the type/length of values, up to a small depth. Useful for spotting
// where the folder list lives without dumping everything.
function summarizeKeys(node: unknown, prefix: string, depth = 0): void {
  if (depth > 5) return;
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    console.log(`${prefix}[array length=${node.length}]`);
    if (node.length > 0) summarizeKeys(node[0], prefix + "  [0]", depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const t = Array.isArray(v) ? `array[${v.length}]` : typeof v;
    console.log(`${prefix}${k}: ${t}`);
    if (typeof v === "object" && v !== null) {
      summarizeKeys(v, prefix + "  ", depth + 1);
    }
  }
}
