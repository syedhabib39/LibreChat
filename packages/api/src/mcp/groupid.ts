import mongoose from 'mongoose';
import { createUserGroupMethods, logger } from '@librechat/data-schemas';
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
    return '';
  }
  const now = Date.now();
  const cached = groupIdCsvByUserId.get(userId);
  if (cached && now - cached.cachedAt < GROUP_ID_CACHE_MS) {
    return cached.value;
  }
  try {
    const groups = await getUserGroupMethods().findGroupsByMemberId(userId);
    const value = groups.map((g: IGroup) => String(g._id)).join(',');
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
    return user;
  }
  const groupId = await loadGroupIdsCsv(user.id);
  return { ...user, groupId };
}

export async function enrichMcpConnectionUserOptions<
  T extends { user?: IUser } | undefined,
>(options?: T): Promise<T | undefined> {
  if (!options?.user?.id) {
    return options;
  }
  const user = await enrichUserForMcp(options.user);
  return { ...options, user } as T;
}
