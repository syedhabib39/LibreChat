import mongoose from 'mongoose';
import { createUserGroupMethods, logger, runAsSystem } from '@librechat/data-schemas';
import type { IGroup, IUser } from '@librechat/data-schemas';

const GROUP_ID_CACHE_MS = 30_000;
const groupIdCsvByUserId = new Map<string, { value: string; cachedAt: number }>();

let userGroupMethods: ReturnType<typeof createUserGroupMethods> | null = null;

function getUserGroupMethods() {
  if (!userGroupMethods) {
    userGroupMethods = createUserGroupMethods(mongoose);
  }
  return userGroupMethods;
}

async function loadGroupIdsCsv(userId: string): Promise<string> {
  if (mongoose.connection.readyState !== 1) {
    logger.debug('[MCP][groupId] skip DB lookup: mongoose not connected', {
      userId,
      readyState: mongoose.connection.readyState,
    });
    return '';
  }
  const now = Date.now();
  const cached = groupIdCsvByUserId.get(userId);
  if (cached && now - cached.cachedAt < GROUP_ID_CACHE_MS) {
    logger.debug('[MCP][groupId] cache hit', {
      userId,
      ageMs: now - cached.cachedAt,
      csvLen: cached.value.length,
    });
    return cached.value;
  }
  try {
    /**
     * Group/User models use tenant isolation. If documents lack `tenantId` but ALS has a tenant,
     * `findGroupsByMemberId` would return []. `runAsSystem` skips injection; userId is the
     * authenticated session id (server-trusted), not client input.
     */
    const groups = await runAsSystem(async () =>
      getUserGroupMethods().findGroupsByMemberId(userId),
    );
    const value = groups.map((g: IGroup) => String(g._id)).join(',');
    logger.debug('[MCP][groupId] findGroupsByMemberId (runAsSystem)', {
      userId,
      groupCount: groups.length,
      csvLen: value.length,
    });
    groupIdCsvByUserId.set(userId, { value, cachedAt: now });
    return value;
  } catch (error) {
    logger.warn(`[MCP] Failed to resolve group IDs for user ${userId}`, error);
    return '';
  }
}

/**
 * Attaches `groupId` (comma-separated Group `_id` strings) for MCP
 * `{{LIBRECHAT_USER_GROUPID}}` resolution. Not persisted.
 */
export async function enrichUserForMcp(user?: IUser): Promise<IUser | undefined> {
  if (!user?.id) {
    logger.debug('[MCP][groupId] enrichUserForMcp skipped: no user.id', {
      hasUser: Boolean(user),
    });
    return user;
  }
  const groupId = await loadGroupIdsCsv(user.id);
  logger.debug('[MCP][groupId] enrichUserForMcp done', {
    userId: user.id,
    hasIdOnTheSource: Boolean(user.idOnTheSource),
    groupIdCsvLen: groupId.length,
  });
  return { ...user, groupId };
}

export async function enrichMcpConnectionUserOptions<
  T extends { user?: IUser } | undefined,
>(options?: T): Promise<T | undefined> {
  if (!options?.user?.id) {
    logger.debug('[MCP][groupId] enrichMcpConnectionUserOptions skipped: no options.user.id');
    return options;
  }
  const user = await enrichUserForMcp(options.user);
  return { ...options, user } as T;
}
