import { logger } from '@librechat/data-schemas';
import type { AdminUsersStatsResponse } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';
import type { Response } from 'express';

export interface AdminUserStatsDeps {
  getAdminUsersStats: (resourceCreatedAtRange?: {
    $gte?: Date;
    $lte?: Date;
  }) => Promise<AdminUsersStatsResponse['stats']>;
}

function firstQueryString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}

function parseIsoDateQueryValue(raw: string | undefined): Date | undefined | 'invalid' {
  if (raw == null) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return 'invalid';
  }
  return parsed;
}

function createGetUsersStatsHandler(deps: AdminUserStatsDeps) {
  const { getAdminUsersStats } = deps;

  return async function getUsersStatsHandler(req: ServerRequest, res: Response) {
    try {
      const startRaw = firstQueryString(req.query.startDate);
      const endRaw = firstQueryString(req.query.endDate);
      const startParsed = parseIsoDateQueryValue(startRaw);
      const endParsed = parseIsoDateQueryValue(endRaw);

      if (startParsed === 'invalid') {
        return res
          .status(400)
          .json({ error: 'Invalid startDate: expected a valid ISO 8601 datetime string' });
      }
      if (endParsed === 'invalid') {
        return res
          .status(400)
          .json({ error: 'Invalid endDate: expected a valid ISO 8601 datetime string' });
      }

      if (startParsed && endParsed && startParsed.getTime() > endParsed.getTime()) {
        return res.status(400).json({ error: 'startDate must be before or equal to endDate' });
      }

      const resourceCreatedAtRange =
        startParsed != null || endParsed != null
          ? {
              ...(startParsed != null ? { $gte: startParsed } : {}),
              ...(endParsed != null ? { $lte: endParsed } : {}),
            }
          : undefined;

      const stats = await getAdminUsersStats(resourceCreatedAtRange);

      const body: AdminUsersStatsResponse = {
        stats,
        filters: {
          ...(startParsed != null ? { startDate: startParsed.toISOString() } : {}),
          ...(endParsed != null ? { endDate: endParsed.toISOString() } : {}),
        },
      };

      return res.status(200).json(body);
    } catch (error) {
      logger.error('[adminUsers] getUsersStats error:', error);
      return res.status(500).json({ error: 'Failed to load user stats' });
    }
  };
}

export function createAdminUserStatsHandlers(deps: AdminUserStatsDeps) {
  return {
    getUsersStats: createGetUsersStatsHandler(deps),
  };
}
