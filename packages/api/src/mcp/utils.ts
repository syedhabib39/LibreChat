import { Constants } from 'librechat-data-provider';
import { logger } from '@librechat/data-schemas';
import type { ParsedServerConfig } from '~/mcp/types';

export const mcpToolPattern = new RegExp(`^.+${Constants.mcp_delimiter}.+$`);

/** Checks that `customUserVars` is present AND non-empty (guards against truthy `{}`) */
export function hasCustomUserVars(config: Pick<ParsedServerConfig, 'customUserVars'>): boolean {
  return !!config.customUserVars && Object.keys(config.customUserVars).length > 0;
}

/**
 * Determines whether a server config is user-sourced (sandboxed placeholder resolution).
 * When `source` is set, it is authoritative. When absent (pre-upgrade cached configs),
 * falls back to the legacy `dbId` heuristic for backward compatibility.
 */
export function isUserSourced(config: Pick<ParsedServerConfig, 'source' | 'dbId'>): boolean {
  return config.source != null ? config.source === 'user' : !!config.dbId;
}

const LIBRECHAT_USER_PLACEHOLDER = /\{\{LIBRECHAT_USER_[^}]+\}\}/;

/**
 * True if the server config embeds `{{LIBRECHAT_USER_*}}` in url/headers/env/args/oauth strings.
 * Such servers must use a per-user MCP connection — app-level pools have no user for `processMCPEnv`.
 */
export function configContainsLibrechatUserPlaceholders(config: {
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  args?: string[];
  oauth?: Record<string, boolean | string | string[] | undefined>;
}): boolean {
  if (config.url != null && LIBRECHAT_USER_PLACEHOLDER.test(config.url)) {
    return true;
  }
  if (config.headers) {
    for (const v of Object.values(config.headers)) {
      if (typeof v === 'string' && LIBRECHAT_USER_PLACEHOLDER.test(v)) {
        return true;
      }
    }
  }
  if (config.env) {
    for (const v of Object.values(config.env)) {
      if (typeof v === 'string' && LIBRECHAT_USER_PLACEHOLDER.test(v)) {
        return true;
      }
    }
  }
  if (config.args) {
    for (const arg of config.args) {
      if (LIBRECHAT_USER_PLACEHOLDER.test(arg)) {
        return true;
      }
    }
  }
  if (config.oauth) {
    for (const v of Object.values(config.oauth)) {
      if (typeof v === 'string' && LIBRECHAT_USER_PLACEHOLDER.test(v)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Merge header objects; later layers win. Keys are lowercased so `X-User-Id` and `x-user-id`
 * do not both appear (avoids comma-joined duplicate values on the wire).
 */
export function mergeMcpHttpHeaders(
  ...layers: Array<Record<string, string> | null | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of layers) {
    if (layer == null) {
      continue;
    }
    for (const [k, v] of Object.entries(layer)) {
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}

/**
 * Allowlist-based sanitization for API responses. Only explicitly listed fields are included;
 * new fields added to ParsedServerConfig are excluded by default until allowlisted here.
 *
 * URLs are returned as-is: DB-stored configs reject ${VAR} patterns at validation time
 * (MCPServerUserInputSchema), and YAML configs are admin-managed. Env variable resolution
 * is handled at the schema/input boundary, not the output boundary.
 */
export function redactServerSecrets(config: ParsedServerConfig): Partial<ParsedServerConfig> {
  const safe: Partial<ParsedServerConfig> = {
    type: config.type,
    url: config.url,
    title: config.title,
    description: config.description,
    iconPath: config.iconPath,
    chatMenu: config.chatMenu,
    requiresOAuth: config.requiresOAuth,
    capabilities: config.capabilities,
    tools: config.tools,
    toolFunctions: config.toolFunctions,
    initDuration: config.initDuration,
    updatedAt: config.updatedAt,
    dbId: config.dbId,
    /** Trust tier (yaml/config/user) — safe to expose; used by the UI for display purposes. */
    source: config.source,
    consumeOnly: config.consumeOnly,
    inspectionFailed: config.inspectionFailed,
    customUserVars: config.customUserVars,
    serverInstructions: config.serverInstructions,
  };

  if (config.apiKey) {
    safe.apiKey = {
      source: config.apiKey.source,
      authorization_type: config.apiKey.authorization_type,
      ...(config.apiKey.custom_header && { custom_header: config.apiKey.custom_header }),
    };
  }

  if (config.oauth) {
    const { client_secret: _secret, ...safeOAuth } = config.oauth;
    safe.oauth = safeOAuth;
  }

  return Object.fromEntries(
    Object.entries(safe).filter(([, v]) => v !== undefined),
  ) as Partial<ParsedServerConfig>;
}

/** Applies allowlist-based sanitization to a map of server configs. */
export function redactAllServerSecrets(
  configs: Record<string, ParsedServerConfig>,
): Record<string, Partial<ParsedServerConfig>> {
  const result: Record<string, Partial<ParsedServerConfig>> = {};
  for (const [key, config] of Object.entries(configs)) {
    result[key] = redactServerSecrets(config);
  }
  return result;
}

/**
 * Normalizes a server name to match the pattern ^[a-zA-Z0-9_.-]+$
 * This is required for Azure OpenAI models with Tool Calling
 */
export function normalizeServerName(serverName: string): string {
  // Check if the server name already matches the pattern
  if (/^[a-zA-Z0-9_.-]+$/.test(serverName)) {
    return serverName;
  }

  /** Replace non-matching characters with underscores.
    This preserves the general structure while ensuring compatibility.
    Trims leading/trailing underscores
    */
  const normalized = serverName.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^_+|_+$/g, '');

  // If the result is empty (e.g., all characters were non-ASCII and got trimmed),
  // generate a fallback name to ensure we always have a valid function name
  if (!normalized) {
    /** Hash of the original name to ensure uniqueness */
    let hash = 0;
    for (let i = 0; i < serverName.length; i++) {
      hash = (hash << 5) - hash + serverName.charCodeAt(i);
      hash |= 0; // Convert to 32bit integer
    }
    return `server_${Math.abs(hash)}`;
  }

  return normalized;
}

/**
 * Builds the synthetic tool-call name used during MCP OAuth flows.
 * Format: `oauth<mcp_delimiter><normalizedServerName>`
 *
 * Guards against the caller passing a pre-wrapped name (one that already
 * starts with the oauth prefix in its original, un-normalized form) to
 * prevent double-wrapping.
 */
export function buildOAuthToolCallName(serverName: string): string {
  const oauthPrefix = `oauth${Constants.mcp_delimiter}`;
  if (serverName.startsWith(oauthPrefix)) {
    return normalizeServerName(serverName);
  }
  return `${oauthPrefix}${normalizeServerName(serverName)}`;
}

/**
 * Sanitizes a URL by removing query parameters to prevent credential leakage in logs.
 * @param url - The URL to sanitize (string or URL object)
 * @returns The sanitized URL string without query parameters
 */
export function sanitizeUrlForLogging(url: string | URL): string {
  try {
    const urlObj = typeof url === 'string' ? new URL(url) : url;
    return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
  } catch {
    return '[invalid URL]';
  }
}

/**
 * Escapes special regex characters in a string so they are treated literally.
 * @param str - The string to escape
 * @returns The escaped string safe for use in a regex pattern
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generates a URL-friendly server name from a title.
 * Converts to lowercase, replaces spaces with hyphens, removes special characters.
 * @param title - The display title to convert
 * @returns A slug suitable for use as serverName (e.g., "GitHub MCP Tool" → "github-mcp-tool")
 */
export function generateServerNameFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars except spaces and hyphens
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Remove consecutive hyphens
    .replace(/^-|-$/g, ''); // Trim leading/trailing hyphens

  return slug || 'mcp-server'; // Fallback if empty
}

/** Matches any `{{LIBRECHAT_*}}` substring left in a header value after processing */
const LIBRECHAT_HEADER_PLACEHOLDER = /\{\{LIBRECHAT_[^}]+\}\}/;

function redactMcpHeaderValueForLog(headerName: string, value: string): string {
  if (LIBRECHAT_HEADER_PLACEHOLDER.test(value)) {
    return '<unresolved LIBRECHAT_* placeholder>';
  }
  const lower = headerName.toLowerCase();
  if (
    lower === 'authorization' ||
    lower.includes('email') ||
    lower.includes('token') ||
    lower.includes('secret') ||
    lower.includes('password')
  ) {
    return `<redacted len=${value.length}>`;
  }
  if (value.length > 96) {
    return `${value.slice(0, 96)}…(${value.length} chars)`;
  }
  return value;
}

/**
 * Header names that differ only by case (e.g. `X-User-Email` vs `x-user-email`) can produce
 * duplicate logical headers and comma-merged values downstream.
 */
export function mcpDuplicateHeaderCasing(keys: string[]): string[] {
  const byLower = new Map<string, string[]>();
  for (const k of keys) {
    const lower = k.toLowerCase();
    if (!byLower.has(lower)) {
      byLower.set(lower, []);
    }
    byLower.get(lower)!.push(k);
  }
  const out: string[] = [];
  for (const variants of byLower.values()) {
    if (variants.length > 1) {
      out.push(variants.join(' | '));
    }
  }
  return out;
}

export function mcpHeaderKeysOverlapCaseInsensitive(
  initHeaders: Record<string, string>,
  dynamicHeaders: Record<string, string>,
): string[] {
  const lowerInit = new Set(Object.keys(initHeaders).map((k) => k.toLowerCase()));
  return Object.keys(dynamicHeaders).filter((k) => lowerInit.has(k.toLowerCase()));
}

/**
 * Verbose MCP header diagnostics. Enable with `DEBUG_LEVEL=debug` / your deployment’s debug log level.
 */
export function debugMcpHeaders(
  stage: string,
  headers: Record<string, string> | null | undefined,
  extra?: Record<string, unknown>,
): void {
  if (headers == null || Object.keys(headers).length === 0) {
    logger.debug(`[MCP][headers] ${stage}`, { ...extra, headerNames: [], note: 'no headers' });
    return;
  }
  const unresolvedPlaceholderKeys: string[] = [];
  const valuesRedacted: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string' && LIBRECHAT_HEADER_PLACEHOLDER.test(v)) {
      unresolvedPlaceholderKeys.push(k);
    }
    valuesRedacted[k] = redactMcpHeaderValueForLog(k, typeof v === 'string' ? v : String(v));
  }
  logger.debug(`[MCP][headers] ${stage}`, {
    ...extra,
    headerNames: Object.keys(headers).sort(),
    duplicateCasingVariants: mcpDuplicateHeaderCasing(Object.keys(headers)),
    unresolvedPlaceholderKeys,
    valuesRedacted,
  });
}

export function debugMcpFetchMerge(
  stage: string,
  meta: Record<string, unknown>,
  method: string,
  urlInput: string | URL | Request,
  initHeaders: Record<string, string>,
  dynamicHeaders: Record<string, string>,
): void {
  let urlStr: string;
  if (typeof urlInput === 'string') {
    urlStr = urlInput;
  } else if (urlInput instanceof URL) {
    urlStr = urlInput.href;
  } else {
    urlStr = urlInput.url;
  }
  logger.debug(`[MCP][fetch-merge] ${stage}`, {
    ...meta,
    method,
    url: sanitizeUrlForLogging(urlStr),
    initHeaderKeys: Object.keys(initHeaders).sort(),
    dynamicHeaderKeys: Object.keys(dynamicHeaders).sort(),
    caseInsensitiveKeyOverlap: mcpHeaderKeysOverlapCaseInsensitive(initHeaders, dynamicHeaders),
  });
}
