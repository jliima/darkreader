// Live settings from Themer (https://github.com/jliima/themer).
//
// The Themer native messaging host ("themer", plugins/browser in the Themer repository) pushes the applied theme
// whenever `themer apply` runs:
//   tokens:   the resolved colors of the applied variant (~/.cache/themer/colors.json)
//   settings: Dark Reader settings rendered from the user's template (~/.cache/themer/browser/darkreader.json), a
//             partial UserSettings object, e.g. {"enabled": true, "theme": {"mode": 1, "contrast": 110, ...}}
// Without a template the page background and text colors follow the theme's bg and text tokens, and the mode follows
// the variant.

import {DEFAULT_SETTINGS, DEFAULT_THEME} from '../defaults';
import type {Theme, UserSettings} from '../definitions';
import {validateSettings} from '../utils/validation';

import {Extension} from './extension';
import UserStorage from './user-storage';
import {logInfo, logWarn} from './utils/log';

const HOST = 'themer';
const RETRY_MIN = 5 * 1000;
const RETRY_MAX = 5 * 60 * 1000;

interface ThemerTokens {
    theme?: string;
    variant?: 'dark' | 'light';
    colors?: Record<string, string>;
}

type ThemerMessage = {
    type: 'theme';
    tokens: ThemerTokens | null;
    settings: Partial<UserSettings> | null;
} | {
    type: 'error';
    message: string;
};

let retryDelay = RETRY_MIN;
let port: chrome.runtime.Port | null = null;

function isPlainObject(x: unknown): x is Record<string, any> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function hex6(color: string | undefined): string | undefined {
    return color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : undefined;
}

// What to apply when the user has no template: colors and mode from the tokens.
function settingsFromTokens(tokens: ThemerTokens): Partial<UserSettings> {
    const bg = hex6(tokens.colors?.bg);
    const text = hex6(tokens.colors?.text);
    const theme: Partial<Theme> = {};
    if (tokens.variant === 'light') {
        theme.mode = 0;
        bg && (theme.lightSchemeBackgroundColor = bg);
        text && (theme.lightSchemeTextColor = text);
    } else {
        theme.mode = 1;
        bg && (theme.darkSchemeBackgroundColor = bg);
        text && (theme.darkSchemeTextColor = text);
    }
    return {theme: theme as Theme};
}

// Keeps the keys Dark Reader knows and whose values pass its own validation; the rest are reported and left alone.
function sanitize(input: Partial<UserSettings>): {settings: Partial<UserSettings>; problems: string[]} {
    const problems: string[] = [];
    const known: Record<string, any> = {};
    for (const [key, value] of Object.entries(input)) {
        if (!(key in DEFAULT_SETTINGS)) {
            problems.push(`unknown setting "${key}"`);
        } else if (key === 'theme') {
            if (!isPlainObject(value)) {
                problems.push('"theme" is not an object');
                continue;
            }
            const theme: Record<string, any> = {};
            for (const [k, v] of Object.entries(value)) {
                k in DEFAULT_THEME ? (theme[k] = v) : problems.push(`unknown theme setting "${k}"`);
            }
            known.theme = theme;
        } else {
            known[key] = value;
        }
    }

    // validateSettings replaces a bad value with the default; compare against a copy to find and drop those instead.
    // It always checks a theme, so a partial one is completed from the current settings.
    const checked: Record<string, any> = structuredClone(known);
    checked.theme = {...UserStorage.settings.theme, ...known.theme};
    const {errors} = validateSettings(checked);
    if (errors.length === 0) {
        return {settings: known, problems};
    }
    problems.push(...errors);
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const key of Object.keys(known)) {
        if (key === 'theme') {
            for (const k of Object.keys(known.theme)) {
                if (!same(known.theme[k], checked.theme[k])) {
                    delete known.theme[k];
                }
            }
        } else if (!same(known[key], checked[key])) {
            delete known[key];
        }
    }
    return {settings: known, problems};
}

// Only what differs from the current settings, with nested objects merged, so an unchanged theme re-renders nothing.
function changesFrom(current: UserSettings, incoming: Partial<UserSettings>): Partial<UserSettings> {
    const changes: Record<string, any> = {};
    for (const [key, value] of Object.entries(incoming)) {
        const now = (current as Record<string, any>)[key];
        const next = isPlainObject(value) && isPlainObject(now) ? {...now, ...value} : value;
        if (JSON.stringify(next) !== JSON.stringify(now)) {
            changes[key] = next;
        }
    }
    return changes;
}

async function apply(tokens: ThemerTokens | null, settings: Partial<UserSettings> | null) {
    const input = isPlainObject(settings) ? settings : tokens ? settingsFromTokens(tokens) : null;
    if (!input) {
        return;
    }
    const {settings: valid, problems} = sanitize(input);
    for (const problem of problems) {
        logWarn(`Themer: ${problem}`);
        port?.postMessage({type: 'log', message: `darkreader: ignored ${problem}`});
    }
    const changes = changesFrom(UserStorage.settings, valid);
    if (Object.keys(changes).length === 0) {
        return;
    }
    logInfo('Themer: applying', changes);
    await Extension.changeSettings(changes);
}

function connect(ready: Promise<void>) {
    port = chrome.runtime.connectNative(HOST);
    let queue = Promise.resolve();

    port.onMessage.addListener((message: ThemerMessage) => {
        retryDelay = RETRY_MIN;
        if (message.type === 'theme') {
            const {tokens, settings} = message;
            // Applied in order, and only once Dark Reader has loaded its own settings.
            queue = queue.then(() => ready).then(() => apply(tokens, settings)).catch((err) => logWarn('Themer:', err));
        } else if (message.type === 'error') {
            logWarn(`Themer host: ${message.message}`);
        }
    });

    port.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError?.message;
        logWarn(`Themer host disconnected${error ? `: ${error}` : ''}; retrying in ${retryDelay / 1000} s`);
        port = null;
        setTimeout(() => connect(ready), retryDelay);
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
    });

    port.postMessage({type: 'hello', app: 'darkreader'});
}

export function connectThemer(ready: Promise<void>): void {
    if (!chrome.runtime.connectNative) {
        return;
    }
    connect(ready);
}
