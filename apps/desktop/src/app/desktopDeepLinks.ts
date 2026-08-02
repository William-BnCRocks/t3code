// Pure, electron-free parsing for `t3code://` (production) / `t3code-dev://`
// (development) deep links. Kept free of any Electron API so it can be unit
// tested directly and reused from both the cold-start argv scan and the
// macOS `open-url` event handler.
//
// Only `getDesktopScheme` is imported from ElectronProtocol.ts -- it is a
// pure string helper (no Electron API calls at import or call time), so
// reusing it here keeps the accepted scheme in sync with the protocol
// registration instead of duplicating the constants.
import { DESKTOP_HOST, getDesktopScheme } from "../electron/ElectronProtocol.ts";

// Defensive cap on the prompt carried by a deep link. Deep links arrive as
// OS-level argv/URL data outside our control (other apps, shell scripts,
// clipboard mishaps); truncate rather than let an enormous prompt reach the
// composer store or IPC payloads.
export const DEEP_LINK_MAX_PROMPT_LENGTH = 32_000;

// The only host a deep link may target. `DESKTOP_HOST` ("app") is the
// renderer's own document origin and must never be treated as a deep-link
// route.
const NEW_THREAD_HOST = "new";

export interface DesktopDeepLinkNewThread {
  readonly kind: "new-thread";
  readonly prompt: string | null;
}

export type DesktopDeepLink = DesktopDeepLinkNewThread;

export interface DesktopDeepLinkParseOptions {
  readonly isDevelopment: boolean;
}

function normalizePrompt(rawPrompt: string | null): string | null {
  if (rawPrompt === null) return null;
  const trimmed = rawPrompt.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > DEEP_LINK_MAX_PROMPT_LENGTH
    ? trimmed.slice(0, DEEP_LINK_MAX_PROMPT_LENGTH)
    : trimmed;
}

/**
 * Parses a single deep-link URL string. Returns `null` when the URL is not a
 * well-formed URL, targets the wrong scheme for this build flavor, or
 * targets a host other than the accepted deep-link route(s).
 *
 * Handles all three shapes a custom-scheme URL can take depending on how the
 * OS/shell hands it off:
 *   - `t3code://new?prompt=...` (host = "new")
 *   - `t3code://new/?prompt=...` (host = "new", pathname = "/")
 *   - `t3code:new?prompt=...` (opaque form; host = "", pathname = "new")
 */
export function parseDesktopDeepLink(
  rawUrl: string,
  options: DesktopDeepLinkParseOptions,
): DesktopDeepLink | null {
  const expectedScheme = `${getDesktopScheme(options.isDevelopment)}:`;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== expectedScheme) {
    return null;
  }

  const host = url.hostname.toLowerCase();
  const pathRoute = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
  const route = host.length > 0 ? host : pathRoute;

  if (route === DESKTOP_HOST) {
    // `t3code://app/...` is the renderer's own document origin, never a
    // deep-link target.
    return null;
  }

  if (route !== NEW_THREAD_HOST) {
    return null;
  }

  return {
    kind: "new-thread",
    prompt: normalizePrompt(url.searchParams.get("prompt")),
  };
}

/**
 * Scans argv (Windows/Linux cold start and second-instance argv) for a deep
 * link, returning the last matching entry. Chromium/installer flags (e.g.
 * `--allow-file-access-from-files`, the exe path, a leading `--`) are
 * ignored -- only entries starting with the accepted scheme are considered.
 * Scanning for the *last* match matters because Windows can append the URL
 * after other launcher-injected arguments.
 */
export function findDeepLinkInArgv(
  argv: readonly string[],
  options: DesktopDeepLinkParseOptions,
): string | null {
  const expectedPrefix = `${getDesktopScheme(options.isDevelopment)}:`;
  let match: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith(expectedPrefix)) {
      match = arg;
    }
  }
  return match;
}
