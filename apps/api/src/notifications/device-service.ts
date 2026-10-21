import { unauthorized } from '../http/errors';
import type { DevicePlatform, NotificationsRepo } from './repo';

/** The acting principal (from req.principal). */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface DeviceServiceDeps {
  repo: NotificationsRepo;
}

/** Register/refresh a caller's push token so notifications can reach their device(s). */
export function createDeviceService(deps: DeviceServiceDeps) {
  async function registerDevice(
    actor: Actor,
    input: { pushToken: string; platform: DevicePlatform },
  ): Promise<{ registered: true }> {
    const userId = await deps.repo.findUserIdByUlid(actor.ulid);
    if (userId === null) {
      throw unauthorized('Unknown principal');
    }
    await deps.repo.upsertDevice(userId, input.pushToken, input.platform);
    return { registered: true };
  }

  return { registerDevice };
}

export type DeviceService = ReturnType<typeof createDeviceService>;
