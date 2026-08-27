import type { UserProfile } from "@open-managed-agents/domain/user-profiles";
import type { UserProfileStore } from "@open-managed-agents/user-profile-store";
import type {
  CreateEnrollmentUrlCommand,
  CreateEnrollmentUrlResult,
  CreateUserProfileCommand,
  CreateUserProfileResult,
  ListUserProfilesQuery,
  ListUserProfilesResult,
  RetrieveUserProfileQuery,
  RetrieveUserProfileResult,
  UpdateUserProfileCommand,
  UpdateUserProfileResult,
  UserProfilesApplicationPort,
} from "../ports/user-profiles";
import type { UserProfileEnrollmentIssuerPort } from "./enrollment-issuer";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function encodeCursorPart(value: string): string {
  return btoa(encodeURIComponent(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursorPart(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
  try {
    const decoded = decodeURIComponent(atob(padded));
    return encodeCursorPart(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function encodeCursor(profile: UserProfile, order: "asc" | "desc"): string {
  return `user_profiles.${order}.${encodeCursorPart(profile.createdAt)}.${encodeCursorPart(profile.id)}`;
}

function decodeCursor(
  value: string,
): { createdAt: string; userProfileId: string; order: "asc" | "desc" } | null {
  const [scope, order, createdAt, userProfileId, extra] = value.split(".");
  if (
    scope !== "user_profiles" ||
    (order !== "asc" && order !== "desc") ||
    createdAt === undefined ||
    userProfileId === undefined ||
    extra !== undefined
  ) return null;
  const decodedCreatedAt = decodeCursorPart(createdAt);
  const decodedUserProfileId = decodeCursorPart(userProfileId);
  if (
    decodedCreatedAt === null ||
    decodedUserProfileId === null ||
    decodedUserProfileId.length === 0 ||
    Number.isNaN(Date.parse(decodedCreatedAt)) ||
    new Date(decodedCreatedAt).toISOString() !== decodedCreatedAt
  ) return null;
  return {
    createdAt: decodedCreatedAt,
    userProfileId: decodedUserProfileId,
    order,
  };
}

function cloneProfile(profile: UserProfile): UserProfile {
  return {
    ...profile,
    metadata: { ...profile.metadata },
    trustGrants: Object.fromEntries(
      Object.entries(profile.trustGrants).map(([name, grant]) => [
        name,
        { ...grant },
      ]),
    ),
  };
}

function patchMetadata(
  current: Record<string, string>,
  patch: Record<string, string>,
): Record<string, string> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === "") delete next[key];
    else next[key] = value;
  }
  return next;
}

export interface UserProfilesApplicationServiceDependencies {
  workspaceId: string;
  store: UserProfileStore;
  enrollment: UserProfileEnrollmentIssuerPort;
  clock: { now(): Date };
  ids: { nextUserProfileId(): string };
}

export class UserProfilesApplicationService
  implements UserProfilesApplicationPort
{
  constructor(
    private readonly dependencies: UserProfilesApplicationServiceDependencies,
  ) {}

  async createUserProfile(
    command: CreateUserProfileCommand,
  ): Promise<CreateUserProfileResult> {
    const timestamp = this.dependencies.clock.now().toISOString();
    const profile: UserProfile = {
      id: this.dependencies.ids.nextUserProfileId(),
      createdAt: timestamp,
      metadata: { ...(command.metadata ?? {}) },
      trustGrants: {},
      updatedAt: timestamp,
      ...(command.accessType !== undefined && {
        accessType: command.accessType,
      }),
      ...(command.externalId !== undefined && {
        externalId: command.externalId,
      }),
      ...(command.name !== undefined && { name: command.name }),
      ...(command.relationship !== undefined && {
        relationship: command.relationship,
      }),
    };
    const record = await this.dependencies.store.insert({
      workspaceId: this.dependencies.workspaceId,
      profile,
    });
    return { type: "created", profile: cloneProfile(record.profile) };
  }

  async retrieveUserProfile(
    query: RetrieveUserProfileQuery,
  ): Promise<RetrieveUserProfileResult> {
    const record = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      userProfileId: query.userProfileId,
    });
    return record === null
      ? { type: "not_found" }
      : { type: "found", profile: cloneProfile(record.profile) };
  }

  async updateUserProfile(
    command: UpdateUserProfileCommand,
  ): Promise<UpdateUserProfileResult> {
    const current = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      userProfileId: command.userProfileId,
    });
    if (current === null) return { type: "not_found" };
    const next = cloneProfile(current.profile);
    next.updatedAt = this.dependencies.clock.now().toISOString();
    if (command.metadata !== undefined) {
      next.metadata = patchMetadata(next.metadata, command.metadata);
    }
    if (command.accessType !== undefined) {
      if (command.accessType === null) delete next.accessType;
      else next.accessType = command.accessType;
    }
    if (command.externalId !== undefined) next.externalId = command.externalId;
    if (command.name !== undefined) next.name = command.name;
    if (command.relationship !== undefined) {
      if (command.relationship === null) delete next.relationship;
      else next.relationship = command.relationship;
    }
    const replaced = await this.dependencies.store.replace({
      workspaceId: this.dependencies.workspaceId,
      userProfileId: command.userProfileId,
      expectedRevision: current.revision,
      next,
    });
    if (replaced.type === "not_found") return { type: "not_found" };
    if (replaced.type === "revision_conflict") {
      return {
        type: "version_conflict",
        message: `User profile changed concurrently at revision ${replaced.actualRevision}`,
      };
    }
    return {
      type: "updated",
      profile: cloneProfile(replaced.record.profile),
    };
  }

  async listUserProfiles(
    query: ListUserProfilesQuery,
  ): Promise<ListUserProfilesResult> {
    const order = query.order ?? "desc";
    const position =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    if (position === null) {
      return {
        type: "invalid_request",
        message: "Invalid user profile page cursor",
      };
    }
    if (position !== undefined && position.order !== order) {
      return {
        type: "invalid_request",
        message: "User profile page cursor order does not match the request",
      };
    }
    const pageSize = Math.min(
      Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const records = await this.dependencies.store.list({
      workspaceId: this.dependencies.workspaceId,
      limit: pageSize + 1,
      order,
      ...(position !== undefined && { position }),
    });
    const hasMore = records.length > pageSize;
    const pageRecords = hasMore ? records.slice(0, pageSize) : records;
    const last = pageRecords.at(-1);
    return {
      type: "page",
      page: {
        profiles: pageRecords.map((record) => cloneProfile(record.profile)),
        nextCursor:
          hasMore && last !== undefined
            ? encodeCursor(last.profile, order)
            : null,
      },
    };
  }

  async createEnrollmentUrl(
    command: CreateEnrollmentUrlCommand,
  ): Promise<CreateEnrollmentUrlResult> {
    const record = await this.dependencies.store.find({
      workspaceId: this.dependencies.workspaceId,
      userProfileId: command.userProfileId,
    });
    if (record === null) return { type: "not_found" };
    const result = await this.dependencies.enrollment.issue({
      workspaceId: this.dependencies.workspaceId,
      profile: cloneProfile(record.profile),
    });
    return result.type === "conflict"
      ? result
      : { type: "created", enrollment: result.enrollment };
  }
}
