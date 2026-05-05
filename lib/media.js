// Media capture helpers — screenshot, file pick, YouTube transcript.
// Mac-only today (uses macOS-native screencapture + osascript). Cross-platform
// in a later release.

import { spawnSync, spawn } from 'child_process';
import { statSync } from 'fs';
import { join, extname } from 'path';
import { tmpdir } from 'os';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.tif', '.webp', '.heic', '.heif']);

// Fire-and-forget the screenshot+paste pipeline. The hook MUST return
// immediately so CC unblocks its prompt cycle and the input area becomes
// active — only then does the paste have somewhere to land.
//
// The detached background process:
//   1. screencapture -c -i  (blocks for user selection, image → clipboard)
//   2. brief pause so the just-pasted reply is rendered & input is active
//   3. osascript clicks the frontmost app's "Edit > Paste" menu
//
// Requires macOS Accessibility permission for the terminal app. Without
// it, the image still lands in the clipboard and the user can Cmd+V manually.
export function takeScreenshotAndPaste() {
  spawnDetached(buildPasteScript('screencapture -c -i'));
  return {
    ok: true,
    backgrounded: true,
    message: 'Capturing — select a region. The image will paste into your input automatically.',
  };
}

// Build a shell pipeline that runs the capture step, then sends Ctrl+V to
// the frontmost app — this is Claude Code's native image-paste binding
// (CC's status bar literally reads "Image in clipboard · ctrl+v to paste").
//
// We send Ctrl+V, not Cmd+V: CC is a TUI in raw mode, so its key handling
// is independent of the terminal's Cmd+V (which goes through bracketed
// paste). Ctrl+V reaches CC directly as a control character, triggering
// its internal "read clipboard image" path.
function buildPasteScript(captureCmd) {
  return `${captureCmd} && sleep 0.3 && osascript -e '
tell application "System Events"
  keystroke "v" using control down
end tell' >/dev/null 2>&1`;
}

// Fire a shell command in a fully-detached process. Parent exits immediately;
// child becomes an orphan and finishes on its own. Critical for not blocking
// CC's prompt cycle while waiting on screencapture's interactive selection.
function spawnDetached(shellScript) {
  spawn('sh', ['-c', shellScript], {
    stdio: 'ignore',
    detached: true,
  }).unref();
}

// Returns true if the macOS clipboard currently holds image data.
function clipboardHasImage() {
  // `osascript -e "clipboard info"` returns a list like:
  // {{«class PNGf», 12345, «class 8BPS», ...}}
  // For an image-bearing clipboard we expect class PNGf, JPEG, TIFF, or PICT.
  const r = spawnSync('osascript', ['-e', 'clipboard info'], { encoding: 'utf-8' });
  if (r.status !== 0) return false;
  return /PNGf|JPEG|TIFF|PICT|GIFf/.test(r.stdout || '');
}

// Send Ctrl+V (Claude Code's native image-paste binding) to the frontmost
// app. Returns ok:false with a hint if the keystroke was blocked
// (typically: missing Accessibility permission).
function simulatePaste() {
  const r = spawnSync('osascript', [
    '-e', 'tell application "System Events" to keystroke "v" using control down',
  ], { encoding: 'utf-8' });
  if (r.status === 0) return { ok: true };
  const err = (r.stderr || '').trim();
  if (/assistive access|not authorized/i.test(err)) {
    return {
      ok: false,
      hint: 'Grant your terminal Accessibility permission: System Settings → Privacy & Security → Accessibility → toggle on your terminal app, then try again.',
    };
  }
  return { ok: false, hint: err || `osascript exited ${r.status}` };
}

// Open the native file picker. For images: spawn a detached process that
// pops the picker, copies the chosen file to the clipboard, and auto-pastes
// (same fire-and-forget pattern as the screenshot). For non-images, we
// can't use clipboard (CC can't paste non-image files as native attachments)
// so we run the picker synchronously here and return the path for the
// caller to queue via the next-prompt-injection mechanism.
//
// Decision: image vs non-image happens INSIDE the detached process so we
// don't block here. We always go through the synchronous picker first to
// know the file type, then fork to background for image-paste.
export function pickFileAndAttach() {
  // Synchronous file picker (the picker itself is brief, not the bottleneck).
  const script = `try
  set f to choose file with prompt "CloudCtx — select a file"
  POSIX path of f
on error
  return ""
end try`;
  const r = spawnSync('osascript', ['-e', script], { encoding: 'utf-8' });
  if (r.error) return { ok: false, error: `osascript not available: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, error: `osascript exited ${r.status}` };

  const path = (r.stdout || '').trim();
  if (!path) return { ok: false, error: 'cancelled' };

  const ext = extname(path).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);

  if (isImage) {
    // Background: copy image to clipboard, then auto-paste. We don't wait.
    const escaped = path.replace(/"/g, '\\"');
    const copyAndPaste = `osascript -e 'set the clipboard to (read (POSIX file "${escaped}") as «class PNGf»)' 2>/dev/null || osascript -e 'set the clipboard to (read (POSIX file "${escaped}") as TIFF picture)' 2>/dev/null`;
    spawnDetached(buildPasteScript(copyAndPaste));
    return {
      ok: true, kind: 'image', path, backgrounded: true,
      message: `Pasting ${path} into your input as [Image #N]...`,
    };
  }

  // Non-image file — caller queues path for next-prompt injection.
  return { ok: true, kind: 'path', path, message: `File queued: ${path}` };
}

// Copy an image file's pixel data to the clipboard via osascript. Works for
// formats AppleScript's image-coercion supports (PNG, JPEG, GIF, TIFF, PICT).
function copyImageToClipboard(path) {
  const escaped = path.replace(/"/g, '\\"');
  const script = `set the clipboard to (read (POSIX file "${escaped}") as «class PNGf»)`;
  // For non-PNG images this might fail — try TIFF as a fallback (works for JPEG/HEIC).
  let r = spawnSync('osascript', ['-e', script], { encoding: 'utf-8' });
  if (r.status === 0) return { ok: true };
  const fallback = `set the clipboard to (read (POSIX file "${escaped}") as TIFF picture)`;
  r = spawnSync('osascript', ['-e', fallback], { encoding: 'utf-8' });
  if (r.status === 0) return { ok: true };
  return { ok: false, error: (r.stderr || '').trim() || `osascript exited ${r.status}` };
}

export async function fetchYoutubeTranscript(url) {
  let mod;
  try {
    mod = await import('youtube-transcript');
  } catch (e) {
    return {
      ok: false,
      error: 'youtube-transcript module not installed — run: npm install -g cloudctx@latest',
    };
  }
  try {
    const segments = await mod.YoutubeTranscript.fetchTranscript(url);
    if (!segments || !segments.length) {
      return { ok: false, error: 'no transcript available for this video' };
    }
    const text = segments.map(s => s.text).join(' ');
    return { ok: true, text, segmentCount: segments.length, url };
  } catch (e) {
    // The package throws typed errors with informative messages.
    return { ok: false, error: e?.message || String(e) };
  }
}
