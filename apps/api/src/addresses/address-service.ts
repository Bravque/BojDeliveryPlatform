import { newUlid } from '../auth/crypto';
import { notFound, unauthorized } from '../http/errors';
import type { ZoneService } from '../zones/zone-service';
import type { AddressRepo, AddressWithZone } from './repo';

/** The acting principal (from req.principal). Addresses are always scoped to this user. */
export interface Actor {
  ulid: string;
  roles: string[];
}

export interface CreateAddressInput {
  label?: string | null;
  line1: string;
  lat: number;
  lng: number;
}

export interface UpdateAddressInput {
  label?: string | null;
  line1?: string;
  lat?: number;
  lng?: number;
}

export interface AddressSummary {
  ulid: string;
  label: string | null;
  line1: string;
  lat: number;
  lng: number;
  /** Whether this address resolved to a serviceable zone (false = we cannot deliver here yet). */
  serviceable: boolean;
  zone: { ulid: string; name: string } | null;
}

export interface AddressServiceDeps {
  repo: AddressRepo;
  zoneService: ZoneService;
}

function toSummary(a: AddressWithZone): AddressSummary {
  return {
    ulid: a.ulid,
    label: a.label,
    line1: a.line1,
    lat: a.lat,
    lng: a.lng,
    serviceable: a.zoneId !== null,
    zone: a.zoneUlid && a.zoneName ? { ulid: a.zoneUlid, name: a.zoneName } : null,
  };
}

export function createAddressService(deps: AddressServiceDeps) {
  const { repo, zoneService } = deps;

  async function requireUserId(actor: Actor): Promise<number> {
    const userId = await repo.findUserIdByUlid(actor.ulid);
    if (userId === null) {
      throw unauthorized('Unknown principal');
    }
    return userId;
  }

  /** Load an address and assert the actor owns it; 404 either way so existence isn't revealed. */
  async function ownedAddress(actor: Actor, addressUlid: string) {
    const userId = await requireUserId(actor);
    const address = await repo.findAddressByUlid(addressUlid);
    if (!address || address.userId !== userId) {
      throw notFound('Address not found');
    }
    return { userId, address };
  }

  async function createAddress(actor: Actor, input: CreateAddressInput): Promise<AddressSummary> {
    const userId = await requireUserId(actor);
    const zone = await zoneService.resolveZone(input.lat, input.lng);
    const created = await repo.createAddress({
      ulid: newUlid(),
      userId,
      label: input.label ?? null,
      line1: input.line1,
      lat: input.lat,
      lng: input.lng,
      zoneId: zone?.id ?? null,
    });
    return toSummary(created);
  }

  async function listAddresses(actor: Actor): Promise<AddressSummary[]> {
    const userId = await requireUserId(actor);
    const rows = await repo.listAddresses(userId);
    return rows.map(toSummary);
  }

  async function updateAddress(
    actor: Actor,
    addressUlid: string,
    patch: UpdateAddressInput,
  ): Promise<AddressSummary> {
    const { address } = await ownedAddress(actor, addressUlid);

    // Re-resolve the zone whenever the point moves (either coordinate changed).
    const movesPoint = patch.lat !== undefined || patch.lng !== undefined;
    let zoneId: number | null | undefined;
    if (movesPoint) {
      const lat = patch.lat ?? address.lat;
      const lng = patch.lng ?? address.lng;
      const zone = await zoneService.resolveZone(lat, lng);
      zoneId = zone?.id ?? null;
    }

    await repo.updateAddress(address.id, {
      ...(patch.label !== undefined && { label: patch.label }),
      ...(patch.line1 !== undefined && { line1: patch.line1 }),
      ...(patch.lat !== undefined && { lat: patch.lat }),
      ...(patch.lng !== undefined && { lng: patch.lng }),
      ...(zoneId !== undefined && { zoneId }),
    });

    const refreshed = await repo.findAddressWithZoneByUlid(addressUlid);
    if (!refreshed) {
      throw notFound('Address not found');
    }
    return toSummary(refreshed);
  }

  async function deleteAddress(actor: Actor, addressUlid: string): Promise<void> {
    const { address } = await ownedAddress(actor, addressUlid);
    await repo.deleteAddress(address.id);
  }

  return { createAddress, listAddresses, updateAddress, deleteAddress };
}

export type AddressService = ReturnType<typeof createAddressService>;
