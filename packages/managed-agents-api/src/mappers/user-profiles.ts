import type {
  UserProfileCreateBody,
  UserProfileListQuery,
  UserProfileUpdateBody,
} from "../contracts/user-profiles";
import type {
  CreateUserProfileCommand,
  ListUserProfilesQuery,
  UpdateUserProfileCommand,
  UserProfileView,
} from "../ports/user-profiles";

export function toCreateUserProfileCommand(
  body: UserProfileCreateBody,
): CreateUserProfileCommand {
  return {
    ...(body.access_type !== undefined && { accessType: body.access_type }),
    ...(body.external_id !== undefined && { externalId: body.external_id }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
    ...(body.name !== undefined && { name: body.name }),
    ...(body.relationship !== undefined && {
      relationship: body.relationship,
    }),
  };
}

export function toUpdateUserProfileCommand(
  userProfileId: string,
  body: UserProfileUpdateBody,
): UpdateUserProfileCommand {
  return {
    userProfileId,
    ...(body.access_type !== undefined && { accessType: body.access_type }),
    ...(body.external_id !== undefined && { externalId: body.external_id }),
    ...(body.metadata !== undefined && { metadata: body.metadata }),
    ...(body.name !== undefined && { name: body.name }),
    ...(body.relationship !== undefined && {
      relationship: body.relationship,
    }),
  };
}

export function toListUserProfilesQuery(
  query: UserProfileListQuery,
): ListUserProfilesQuery {
  return {
    ...(query.limit !== undefined && { pageSize: query.limit }),
    ...(query.page != null && { cursor: query.page }),
    ...(query.order !== undefined && { order: query.order }),
  };
}

export function toUserProfileResponse(profile: UserProfileView): object {
  return {
    id: profile.id,
    created_at: profile.createdAt,
    metadata: profile.metadata,
    trust_grants: profile.trustGrants,
    type: "user_profile",
    updated_at: profile.updatedAt,
    ...(profile.accessType !== undefined && {
      access_type: profile.accessType,
    }),
    ...(profile.externalId !== undefined && {
      external_id: profile.externalId,
    }),
    ...(profile.name !== undefined && { name: profile.name }),
    ...(profile.relationship !== undefined && {
      relationship: profile.relationship,
    }),
  };
}
