/**
 * grokUsage — active poll path for Grok account billing/credit telemetry.
 *
 * Mirrors `claudeUsage.ts`: this is a *pull* source that reads the Grok CLI's
 * stored credentials from `$GROK_HOME/auth.json` and GETs the CLI's own
 * billing endpoint, the same one the `/cost` slash command reads under the
 * hood — `GET {GROK_CODE_BACKEND_URL || "https://code.grok.com"}/billing?format=credits`
 * with a bearer token and an `x-grok-client-mode: agent` header.
 *
 * Verified response field names (extracted from the `grok` binary's embedded
 * serde field-name strings, not a captured live payload — this environment's
 * `/billing` endpoint was unreachable at authoring time):
 *
 * ```
 * creditUsagePercent, currentPeriod { end, month }, monthlyLimit,
 * onDemandCap, onDemandUsed, prepaidBalance, isUnifiedBillingUser,
 * billingPeriodStart, billingCycle, includedUsed, totalUsed,
 * on_demand_enabled, subscription_tier
 * ```
 *
 * `subscription_tier` observed enum values: `supergrok_heavy`,
 * `supergrok_plus`, `supergrok`, `supergrok_lite`, `x_premium_plus`,
 * `x_premium`, `x_basic`, `api_key`. The normalizer in `providerRateLimits.ts`
 * treats every field access as untrusted/guarded, same as the Claude branch,
 * so an imprecise guess here degrades to "field omitted" rather than a crash
 * or a wrong render.
 *
 * Credential resolution
 * ----------------------
 * `auth.json` lives directly at `$GROK_HOME/auth.json` (default
 * `~/.grok/auth.json` — no extra subdirectory, confirmed against the grok
 * install's own `docs/user-guide/05-configuration.md` "File locations"
 * table). Its shape is a single top-level map keyed by `"<issuer>::<client_id>"`
 * strings (there is normally exactly one entry — the signed-in account); this
 * module takes the first entry it finds. Each entry carries `key` (the bearer
 * JWT), `expires_at` (an ISO-8601 timestamp, observed ~6h TTL), and
 * `auth_mode`.
 *
 * This module never refreshes the token itself — the Grok CLI refreshes
 * `auth.json` on its own use — and never throws or logs a credential value.
 * Callers decide what (if anything) to log about failures; the low-level
 * readers here stay silent so a poller with failure-streak tracking doesn't
 * get double logging every cycle.
 *
 * @module grokUsage
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

const DEFAULT_GROK_CODE_BACKEND_URL = "https://code.grok.com";
const GROK_BILLING_PATH = "/billing?format=credits";
const GROK_USAGE_TIMEOUT_MS = 10_000;
const GROK_CLIENT_MODE_HEADER = "x-grok-client-mode";
const GROK_CLIENT_MODE_VALUE = "agent";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

/**
 * Resolve the on-disk path to a Grok instance's `auth.json`, given its
 * (possibly empty) `homePath` setting. `auth.json` lives directly under the
 * resolved home (no extra subdirectory) — confirmed against the grok
 * install's own "File locations" table (docs/user-guide/05-configuration.md:
 * `~/.grok/auth.json`). Unlike `resolveGrokHomePath` (used to build
 * `GROK_HOME`), the empty-`homePath` default here must land on
 * `~/.grok/auth.json`, not bare `~/auth.json`.
 */
export const resolveGrokAuthPath = Effect.fn("resolveGrokAuthPath")(function* (
  homePath: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const trimmed = homePath.trim();
  if (trimmed.length === 0) {
    return path.join(NodeOS.homedir(), ".grok", "auth.json");
  }
  const resolved = path.resolve(expandHomePath(trimmed));
  return path.join(resolved, "auth.json");
});

/** Resolve the Grok billing endpoint's base URL, honoring `GROK_CODE_BACKEND_URL` when set. */
const resolveGrokCodeBackendUrl = (environment: NodeJS.ProcessEnv = process.env): string => {
  const override = environment.GROK_CODE_BACKEND_URL?.trim();
  return override && override.length > 0 ? override : DEFAULT_GROK_CODE_BACKEND_URL;
};

/**
 * Read and validate a Grok instance's stored bearer token from `auth.json`.
 *
 * `auth.json`'s top level is a map keyed by `"<issuer>::<client_id>"`; this
 * takes the first (or only) entry. Returns `Option.none()` for every failure
 * mode (file missing, JSON parse failure, missing/malformed `key` or
 * `expires_at`, or an expired token) — never throws. Deliberately does not
 * log; see module doc comment. Never refreshes the token — the Grok CLI owns
 * refresh on its own use.
 */
export const readGrokAccessToken = Effect.fn("readGrokAccessToken")(function* (
  authPath: string,
): Effect.fn.Return<Option.Option<string>, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.gen(function* () {
    const contents = yield* fs.readFileString(authPath);
    const parsed: unknown = yield* decodeUnknownJson(contents);
    if (!isRecord(parsed)) {
      return Option.none<string>();
    }
    const entry = Object.values(parsed)[0];
    if (!isRecord(entry)) {
      return Option.none<string>();
    }
    const key = entry.key;
    const expiresAt = entry.expires_at;
    if (typeof key !== "string" || key.trim().length === 0) {
      return Option.none<string>();
    }
    if (typeof expiresAt !== "string" || expiresAt.trim().length === 0) {
      return Option.none<string>();
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      return Option.none<string>();
    }
    const now = yield* Clock.currentTimeMillis;
    if (expiresAtMs <= now) {
      return Option.none<string>();
    }
    return Option.some(key);
  }).pipe(Effect.orElseSucceed(() => Option.none<string>()));
});

/**
 * GET the Grok billing endpoint with a bearer token. Returns
 * `Option.some(parsedJsonBody)` on HTTP 200 with a parseable JSON body,
 * `Option.none()` on any timeout/non-200 (401/403 included)/parse failure.
 * Never throws, never logs the access token.
 */
export const fetchGrokUsage = Effect.fn("fetchGrokUsage")(function* (
  accessToken: string,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<Option.Option<unknown>, never, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;
  const url = `${resolveGrokCodeBackendUrl(environment)}${GROK_BILLING_PATH}`;
  const request = HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeaders({
      Authorization: `Bearer ${accessToken}`,
      [GROK_CLIENT_MODE_HEADER]: GROK_CLIENT_MODE_VALUE,
    }),
  );
  const response = yield* client.execute(request).pipe(
    Effect.timeoutOption(GROK_USAGE_TIMEOUT_MS),
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(response)) {
    return Option.none();
  }
  const httpResponse = response.value;
  if (httpResponse.status !== 200) {
    yield* Effect.logDebug("grok billing endpoint returned a non-200 status", {
      status: httpResponse.status,
    });
    return Option.none();
  }
  return yield* httpResponse.json.pipe(
    Effect.map((json) => Option.some<unknown>(json)),
    Effect.orElseSucceed(() => Option.none<unknown>()),
  );
});
