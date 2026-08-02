# Deep Links

The desktop app registers itself as the handler for a custom URL scheme so other apps, scripts, or browser links can open T3 Code directly into a new chat draft.

## URL Format

```
t3code://new?prompt=<url-encoded text>
```

- **Scheme**: `t3code` for a normal (production) install, `t3code-dev` when running the app in development.
- **Host**: `new` is the only supported target today.
- **`prompt` (optional)**: URL-encoded text to pre-fill into the composer. Omit it (or pass an empty value) to just open a fresh draft with an empty composer.

Example:

```
t3code://new?prompt=Summarize%20the%20open%20PRs%20in%20this%20repo
```

## Behavior

Opening a `t3code://` link:

1. Launches the desktop app if it isn't running, or focuses the existing window if it is.
2. Opens a new chat draft.
3. Pre-fills the composer with `prompt`, if provided.

The prompt is **never sent automatically** — you review and submit it yourself. This applies whether the app was already open, still starting up, or not running at all; the link is held until a window is ready to receive it.

## Platform Notes

- **Windows and Linux**: handled via the OS launching the app with the URL as a command-line argument, both for a cold start and when the app is already running (a second launch attempt hands the URL to the existing instance instead of starting a duplicate).
- **macOS**: handled via the OS's standard URL-open mechanism.

## Scope

Only the `new` host is recognized. Links to other hosts, including the app's own internal origin, are ignored.
