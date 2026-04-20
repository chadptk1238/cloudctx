import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');
const CLAUDE_MD = join(CLAUDE_DIR, 'CLAUDE.md');
const COMMANDS_DIR = join(CLAUDE_DIR, 'commands');
const SAVE_COMMAND_FILE = join(COMMANDS_DIR, 'cloudctx-save.md');
const RENAME_COMMAND_FILE = join(COMMANDS_DIR, 'cloudctx-rename.md');

const SAVE_COMMAND_BODY = `---
description: Save the current Claude Code session under a name for later resume
argument-hint: "<name>"
---

/cloudctx save "$ARGUMENTS"
`;

const RENAME_COMMAND_BODY = `---
description: Rename a saved CloudCtx thread
argument-hint: "<old-name>" "<new-name>"
---

/cloudctx rename $ARGUMENTS
`;

const CLOUDCTX_START = '<!-- cloudctx:start -->';
const CLOUDCTX_END = '<!-- cloudctx:end -->';

function getCloudctxBinPath() {
  // Find where cloudctx is installed globally
  try {
    const result = execSync('which cloudctx', { encoding: 'utf-8' }).trim();
    if (result) return result;
  } catch {}
  // Fallback: try node with the package path
  try {
    const result = execSync('npm root -g', { encoding: 'utf-8' }).trim();
    const globalBin = join(result, 'cloudctx', 'bin', 'cloudctx.js');
    if (existsSync(globalBin)) return `node ${globalBin}`;
  } catch {}
  // Last resort: npx (will work once published to npm)
  return 'npx cloudctx';
}

export function installHook() {
  const binPath = getCloudctxBinPath();

  // Read or create settings.json
  let settings = {};
  if (existsSync(SETTINGS_FILE)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  // Add hooks
  if (!settings.hooks) settings.hooks = {};

  // Remove old hooks that cloudctx replaces
  delete settings.hooks.PreCompact;

  // UserPromptSubmit hook
  settings.hooks.UserPromptSubmit = [
    {
      hooks: [
        {
          type: 'command',
          command: `${binPath} hook`
        }
      ]
    }
  ];

  // SessionEnd hook (async sync)
  settings.hooks.SessionEnd = [
    {
      hooks: [
        {
          type: 'command',
          command: `${binPath} sync`,
          async: true
        }
      ]
    }
  ];

  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

export function installStatusline() {
  const binPath = getCloudctxBinPath();
  let settings = {};
  if (existsSync(SETTINGS_FILE)) {
    try { settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')); } catch {}
  }
  settings.statusLine = {
    type: 'command',
    command: `${binPath} statusline`,
  };
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

export function uninstallStatusline() {
  if (!existsSync(SETTINGS_FILE)) return false;
  let settings;
  try { settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')); } catch { return false; }
  const cmd = settings.statusLine?.command || '';
  if (!cmd.includes('cloudctx') || !cmd.includes('statusline')) return false;
  delete settings.statusLine;
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
  return true;
}

export function uninstallHook() {
  if (!existsSync(SETTINGS_FILE)) return false;

  let settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch {
    return false;
  }

  if (!settings.hooks) return false;

  // Remove only cloudctx hooks
  let changed = false;
  for (const event of ['UserPromptSubmit', 'SessionEnd']) {
    if (settings.hooks[event]) {
      settings.hooks[event] = settings.hooks[event].filter(group => {
        const hooks = group.hooks || [];
        return !hooks.some(h => h.command && h.command.includes('cloudctx'));
      });
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
      changed = true;
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (changed) {
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
  }

  return changed;
}

export function installClaudeMd() {
  const block = `
${CLOUDCTX_START}
## CloudCtx Memory

You have persistent memory across all sessions via CloudCtx.

**Search memory** (use BEFORE guessing at errors, past work, or API details):
\`\`\`
cloudctx query "search terms"
\`\`\`

**Raw SQL** (for complex queries):
\`\`\`
cloudctx sql "SELECT substr(content,1,300), timestamp FROM messages_fts f JOIN messages m ON f.rowid=m.id WHERE messages_fts MATCH 'keyword' AND m.type='assistant' ORDER BY rank LIMIT 5"
\`\`\`

**Search docs** (ingested llms.txt, reference docs):
\`\`\`
cloudctx sql "SELECT title, substr(content,1,300) FROM docs_fts WHERE docs_fts MATCH 'keyword' ORDER BY rank LIMIT 5"
\`\`\`

**Ingest docs:**
\`\`\`
cloudctx docs ingest <url_or_file> [tags]
cloudctx docs list
cloudctx docs search "query"
\`\`\`

**Save/resume threads:**
\`\`\`
cloudctx launch --save "thread-name"
cloudctx launch
\`\`\`

CRITICAL: If something fails, STOP and ASK. Never silently fall back to a different tool, dependency, model, or method.
${CLOUDCTX_END}`;

  let existing = '';
  if (existsSync(CLAUDE_MD)) {
    existing = readFileSync(CLAUDE_MD, 'utf-8');
  }

  // Remove existing cloudctx block if present
  const cleaned = removeCloudctxBlock(existing);

  // Append new block
  writeFileSync(CLAUDE_MD, cleaned.trimEnd() + '\n' + block + '\n');
  return true;
}

export function uninstallClaudeMd() {
  if (!existsSync(CLAUDE_MD)) return false;

  const existing = readFileSync(CLAUDE_MD, 'utf-8');
  const cleaned = removeCloudctxBlock(existing);

  if (cleaned !== existing) {
    writeFileSync(CLAUDE_MD, cleaned);
    return true;
  }

  return false;
}

export function installSlashCommand() {
  if (!existsSync(COMMANDS_DIR)) {
    mkdirSync(COMMANDS_DIR, { recursive: true });
  }
  writeFileSync(SAVE_COMMAND_FILE, SAVE_COMMAND_BODY);
  writeFileSync(RENAME_COMMAND_FILE, RENAME_COMMAND_BODY);
  return true;
}

export function uninstallSlashCommand() {
  let removed = false;
  for (const file of [SAVE_COMMAND_FILE, RENAME_COMMAND_FILE]) {
    if (existsSync(file)) {
      unlinkSync(file);
      removed = true;
    }
  }
  return removed;
}

function removeCloudctxBlock(text) {
  const startIdx = text.indexOf(CLOUDCTX_START);
  const endIdx = text.indexOf(CLOUDCTX_END);

  if (startIdx === -1 || endIdx === -1) return text;

  const before = text.slice(0, startIdx).trimEnd();
  const after = text.slice(endIdx + CLOUDCTX_END.length).trimStart();

  if (before && after) return before + '\n\n' + after;
  if (before) return before + '\n';
  if (after) return after;
  return '';
}
