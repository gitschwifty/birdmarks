// BirdmarksTwitterClient — extends bird's TwitterClient with `getBookmarkFolders()`.
//
// bird ships `getAllBookmarkFolderTimeline(folderId)` (paginating one folder),
// but no method to *list* folders. The BookmarkFoldersSlice GraphQL operation
// fills that gap. We subclass TwitterClient and reach the protected request
// machinery via inheritance, so no fork or vendoring of bird is needed.
//
// ── If folder listing stops working: ──────────────────────────────────────
// X rotates GraphQL query IDs and feature flags roughly every few weeks.
// To refresh:
//   1. Open https://x.com/i/bookmarks in a logged-in Chrome session
//   2. Open DevTools → Network tab → filter for "graphql"
//   3. Click into any folder in the sidebar (or reload the page)
//   4. Find the request whose URL contains "/BookmarkFoldersSlice"
//   5. Copy the queryId hash (URL segment before the operation name)
//      into BOOKMARK_FOLDERS_QUERY_ID below
//   6. Copy the `features=` query param (URL-decoded JSON) into
//      BOOKMARK_FOLDERS_FEATURES below
// ──────────────────────────────────────────────────────────────────────────
import { TwitterClient } from "@steipete/bird";
import type { BookmarkFolder } from "./types";

// queryId for BookmarkFoldersSlice. Source: trevorhobenshield/twitter-api-client.
// Verify against a live X session before trusting in production.
const BOOKMARK_FOLDERS_QUERY_ID = "i78YDd0Tza-dV4SYs58kRg";

// Feature flags. Derived from bird's buildBookmarksFeatures() (which is
// already used for the main Bookmarks endpoint and BookmarkFolderTimeline).
// X's web client appears to send the same feature set across all three
// bookmark-related operations; if BookmarkFoldersSlice rejects this set with
// an error like "the following features cannot be null: …", add the named
// flags here from the live request.
const BOOKMARK_FOLDERS_FEATURES: Record<string, boolean> = {
  rweb_video_screen_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: false,
  responsive_web_grok_annotations_enabled: false,
  responsive_web_jetfuel_frame: true,
  post_ctas_fetch_enabled: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  articles_preview_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  blue_business_profile_image_shape_enabled: true,
  responsive_web_text_conversations_enabled: false,
  tweetypie_unmention_optimization_enabled: true,
  vibe_api_enabled: true,
  interactive_text_enabled: true,
  graphql_timeline_v2_bookmark_timeline: true,
};

export class BirdmarksTwitterClient extends TwitterClient {
  // Lists all bookmark folders for the current user. Returns an empty array
  // if the user has no folders (or no Premium subscription).
  // Throws on rate limit, auth failure, or schema rejection.
  async getBookmarkFolders(): Promise<BookmarkFolder[]> {
    const json = await this.getBookmarkFoldersRaw();
    return extractFoldersFromResponse(json);
  }

  // Returns the raw parsed-JSON response from BookmarkFoldersSlice. Exposed
  // so verification / debugging scripts can inspect the real response shape
  // when X rotates the schema and our extractor can't find the folder list.
  async getBookmarkFoldersRaw(): Promise<unknown> {
    const variables = {}; // BookmarkFoldersSlice takes no variables today
    const url =
      `https://x.com/i/api/graphql/${BOOKMARK_FOLDERS_QUERY_ID}/BookmarkFoldersSlice` +
      `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
      `&features=${encodeURIComponent(JSON.stringify(BOOKMARK_FOLDERS_FEATURES))}`;

    // fetchWithTimeout / getJsonHeaders are protected on TwitterClientBase
    // and accessible to us via inheritance — no type assertions needed.
    const headers: Record<string, string> = this.getJsonHeaders();
    const resp: Response = await this.fetchWithTimeout(url, {
      method: "GET",
      headers,
    });

    if (resp.status === 429) {
      throw new Error(`Rate limit hit fetching bookmark folders (HTTP 429)`);
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => "<unreadable>");
      throw new Error(
        `BookmarkFoldersSlice failed: HTTP ${resp.status} ${resp.statusText} — ${body.slice(0, 500)}`
      );
    }

    const json = (await resp.json()) as { errors?: Array<{ message: string }> };

    if (json.errors && json.errors.length > 0) {
      const messages = json.errors.map((e) => e.message).join("; ");
      throw new Error(
        `BookmarkFoldersSlice returned errors: ${messages}. ` +
          `If this mentions feature flags or query IDs, refresh them — see ` +
          `the header comment in src/folders-client.ts.`
      );
    }

    return json;
  }
}

// Walk the response looking for an array of objects that look like folder
// entries. X's GraphQL responses nest deeply and the exact path has changed
// across rotations; structural traversal is more robust than hardcoding
// `data.viewer.bookmark_collections_slice.items`.
//
// A "folder-like" object has both an id-ish field and a name-ish field.
export function extractFoldersFromResponse(json: unknown): BookmarkFolder[] {
  const found: BookmarkFolder[] = [];
  const seen = new Set<string>();
  walk(json, found, seen);
  return found;
}

function walk(node: unknown, out: BookmarkFolder[], seen: Set<string>): void {
  if (!node) return;

  if (Array.isArray(node)) {
    for (const item of node) walk(item, out, seen);
    return;
  }

  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  // Candidate folder shape: has an id-ish field and a name-ish field
  const id =
    (typeof obj.rest_id === "string" && obj.rest_id) ||
    (typeof obj.id === "string" && obj.id) ||
    (typeof obj.collection_id === "string" && obj.collection_id) ||
    "";
  const name =
    (typeof obj.name === "string" && obj.name) ||
    (typeof obj.custom_name === "string" && obj.custom_name) ||
    (typeof obj.title === "string" && obj.title) ||
    "";

  // Numeric ID looks like an X snowflake (15+ digits). Avoid grabbing every
  // node with id+name (e.g. user objects). Also skip nodes that have a
  // `screen_name` — those are users, not folders.
  const looksLikeFolderId = id && /^\d{6,}$/.test(id);
  const looksLikeUser = "screen_name" in obj || "is_blue_verified" in obj;

  if (id && name && looksLikeFolderId && !looksLikeUser && !seen.has(id)) {
    seen.add(id);
    out.push({ id, name });
  }

  // Recurse into all values
  for (const v of Object.values(obj)) walk(v, out, seen);
}
