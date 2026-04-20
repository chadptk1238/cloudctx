import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getDataDir, ensureDataDir } from './db.js';

const CONFIG_PATH = join(getDataDir(), 'config.json');

const DEFAULTS = {
  statusline: false,
  statusline_color: 'cyan',
  launch_sort: 'time',
};

const KNOWN_KEYS = Object.keys(DEFAULTS);

const KEY_DESCRIPTIONS = {
  statusline: 'Show saved thread name in Claude Code status line',
  statusline_color: 'Color for statusline text (see: cloudctx config colors)',
  launch_sort: 'Default sort order for launch picker: time or alpha',
};

const BOOL_KEYS = new Set(['statusline']);
const STRING_KEYS = new Set(['statusline_color', 'launch_sort']);

export const STATUSLINE_COLORS = {
  default: '',
  black: '30',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  bright_black: '90',
  bright_red: '91',
  bright_green: '92',
  bright_yellow: '93',
  bright_blue: '94',
  bright_magenta: '95',
  bright_cyan: '96',
  bright_white: '97',
};

export function isBoolKey(key) { return BOOL_KEYS.has(key); }
export function isStringKey(key) { return STRING_KEYS.has(key); }

export function getConfigPath() {
  return CONFIG_PATH;
}

function readRaw() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export function getConfig() {
  return { ...DEFAULTS, ...readRaw() };
}

export function getConfigValue(key) {
  return getConfig()[key];
}

export function setConfig(key, value) {
  ensureDataDir();
  const current = readRaw();
  current[key] = value;
  writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2) + '\n');
}

export function unsetConfig(key) {
  if (!existsSync(CONFIG_PATH)) return;
  const current = readRaw();
  delete current[key];
  writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2) + '\n');
}

export function parseBool(val) {
  const v = String(val).toLowerCase().trim();
  if (['true', 'on', '1', 'yes', 'enable', 'enabled'].includes(v)) return true;
  if (['false', 'off', '0', 'no', 'disable', 'disabled'].includes(v)) return false;
  return null;
}

export function isKnownKey(key) {
  return KNOWN_KEYS.includes(key);
}

export function listKnownKeys() {
  return [...KNOWN_KEYS];
}

export function describeKey(key) {
  return KEY_DESCRIPTIONS[key] || '';
}

export function getDefaults() {
  return { ...DEFAULTS };
}
