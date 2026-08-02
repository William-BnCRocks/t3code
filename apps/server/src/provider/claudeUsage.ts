/**
 * claudeUsage — active poll path for Claude account rate-limit telemetry.
 *
 * Mirrors what Claude Code's own `/status` command does under the hood: it
 * reads the CLI's stored OAuth credentials and GETs
 * `https://api.anthropic.com/api/oauth/usage` with a bearer token. This is a
 * *pull* source, distinct from (and more reliable than) the passive Claude
 * Agent SDK `rate_limit_event` stream that `providerRateLimits.ts` also
 * normalizes — the passive stream only carries `five_hour`/`seven_day`
 * windows and frequently omits `utilization` entirely, so its ring often has
 * nothing to render until a turn happens to emit one.
 *
 * Verified response shape (illustrative values below — not a real account's
 * numbers):
 *
 * ```json
 * {
 *   "five_hour": { "utilization": 12.5, "resets_at": "2026-01-01T00:00:00.000000+00:00", "limit_dollars": null, "used_dollars": null, "remaining_dollars": null },
 *   "seven_day": { "utilization": 40.0, "resets_at": "2026-01-05T00:00:00.000000+00:00", "limit_dollars": null, "used_dollars": null, "remaining_dollars": null },
 *   "limits": [
 *     { "kind": "session", "group": "session", "percent": 12.5, "severity": "normal", "resets_at": "2026-01-01T00:00:00.000000+00:00", "scope": null, "is_active": false },
 *     { "kind": "weekly_all", "group": "weekly", "percent": 40.0, "severity": "normal", "resets_at": "2026-01-05T00:00:00.000000+00:00", "scope": null, "is_active": false },
 *     { "kind": "weekly_scoped", "group": "weekly", "percent": 55.0, "severity": "normal", "resets_at": "2026-01-05T00:00:01.000000+00:00", "scope": { "model": { "id": null, "display_name": "Example Model" }, "surface": null }, "is_active": true }
 *   ],
 *   "extra_usage": { "is_enabled": false, "monthly_limit": null, "used_credits": null, "utilization": null, ... },
 *   "spend": { ... }
 * }
 * ```
 *
 * Key facts baked into the normalizer over in `providerRateLimits.ts` (do
 * not re-derive these — they were confirmed against a live authenticated
 * call): `utilization`/`percent` are already 0..100 (not 0..1); `resets_at`
 * is an ISO-8601 string with a timezone offset (not epoch); `limits[]` is
 * the richer, self-describing, forward-compatible source and should be
 * treated as primary, with the top-level `five_hour`/`seven_day` objects as
 * fallback only.
 *
 * Credential resolution
 * ----------------------
 * Each configured Claude instance's `homePath` setting controls where its
 * `.credentials.json` lives, but the mapping isn't `resolveClaudeHomePath`'s
 * output plus a suffix:
 *   - empty `homePath` (the default instance): the Claude CLI never gets
 *     `CLAUDE_CONFIG_DIR` set (see `makeClaudeEnvironment`'s early return in
 *     `ClaudeHome.ts`), so it falls back to its own default —
 *     `<os.homedir()>/.claude/.credentials.json`.
 *   - non-empty `homePath`: `CLAUDE_CONFIG_DIR` is set directly to the
 *     resolved path, and credentials live at `<resolved homePath>/.credentials.json`
 *     (no extra `.claude` subdirectory).
 *
 * This module never throws and never logs a credential value. Callers are
 * responsible for deciding what (if anything) to log about failures — the
 * low-level readers here stay silent so a poller with failure-streak
 * tracking doesn't get double logging every cycle.
 *
 * @module claudeUsage
 */
import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { expandHomePath } from "../pathExpansion.ts";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_USAGE_TIMEOUT_MS = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

/**
 * Resolve the on-disk path to a Claude instance's `.credentials.json`,
 * given its (possibly empty) `homePath` setting. See the module doc comment
 * for why this differs from `resolveClaudeHomePath`'s output.
 */
export const resolveClaudeCredentialsPath = Effect.fn("resolveClaudeCredentialsPath")(function* (
  homePath: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const trimmed = homePath.trim();
  if (trimmed.length === 0) {
    return path.join(NodeOS.homedir(), ".claude", ".credentials.json");
  }
  const resolved = path.resolve(expandHomePath(trimmed));
  return path.join(resolved, ".credentials.json");
});

/**
 * Read and validate a Claude instance's stored OAuth access token.
 *
 * Returns `Option.none()` for every failure mode (file missing, JSON parse
 * failure, missing/malformed `claudeAiOauth.accessToken`, or an expired
 * token) — never throws. Deliberately does not log; see module doc comment.
 */
export const readClaudeAccessToken = Effect.fn("readClaudeAccessToken")(function* (
  credentialsPath: string,
): Effect.fn.Return<Option.Option<string>, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const contents = yield* fs.readFileString(credentialsPath);
    const parsed: unknown = yield* decodeUnknownJson(contents);
    if (!isRecord(parsed)) {
      return Option.none<string>();
    }
    const oauth = parsed.claudeAiOauth;
    if (!isRecord(oauth)) {
      return Option.none<string>();
    }
    const accessToken = oauth.accessToken;
    const expiresAt = oauth.expiresAt;
    if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
      return Option.none<string>();
    }
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
      return Option.none<string>();
    }
    const now = yield* Clock.currentTimeMillis;
    if (expiresAt <= now) {
      return Option.none<string>();
    }
    return Option.some(accessToken);
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));
});

/**
 * GET the Claude usage endpoint with a bearer token. Returns
 * `Option.some(parsedJsonBody)` on HTTP 200 with a parseable JSON body,
 * `Option.none()` on any timeout/non-200/parse failure. Never throws, never
 * logs the access token.
 */
export const fetchClaudeUsage = Effect.fn("fetchClaudeUsage")(function* (
  accessToken: string,
): Effect.fn.Return<Option.Option<unknown>, never, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(CLAUDE_USAGE_URL).pipe(
    HttpClientRequest.setHeaders({
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    }),
  );
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(CLAUDE_USAGE_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(response)) {
    return Option.none();
  }
  const httpResponse = response.value;
  if (httpResponse.status !== 200) {
    yield* Effect.logDebug("claude usage endpoint returned a non-200 status", {
      status: httpResponse.status,
    });
    return Option.none();
  }
  return yield* httpResponse.json.pipe(
    Effect.map((json) => Option.some<unknown>(json)),
    Effect.orElseSucceed(() => Option.none<unknown>()),
  );
});
