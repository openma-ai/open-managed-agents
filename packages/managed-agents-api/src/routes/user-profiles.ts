import { Hono } from "hono";
import {
  resolveApplicationPort,
  type ApplicationPortSource,
} from "../application-port-source";
import { requireBeta, USER_PROFILES_BETA } from "../beta";
import {
  enrollmentUrlResponseSchema,
  userProfileCreateBodySchema,
  userProfileListQuerySchema,
  userProfilePageResponseSchema,
  userProfileResponseSchema,
  userProfileUpdateBodySchema,
} from "../contracts/user-profiles";
import { apiError, conflict, invalidRequest, notFound } from "../errors";
import {
  toCreateUserProfileCommand,
  toListUserProfilesQuery,
  toUpdateUserProfileCommand,
  toUserProfileResponse,
} from "../mappers/user-profiles";
import type { UserProfilesApplicationPort } from "../ports/user-profiles";

function invalidField(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  return invalidRequest(
    `Invalid request field ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid value"}`,
  );
}

async function requestBody(c: { req: { json(): Promise<unknown> } }) {
  try {
    return { type: "parsed" as const, body: await c.req.json() };
  } catch {
    return { type: "invalid" as const };
  }
}

export function buildUserProfileRoutes(
  source: ApplicationPortSource<UserProfilesApplicationPort>,
): Hono {
  const app = new Hono();
  app.use("*", requireBeta(USER_PROFILES_BETA));

  app.post("/", async (c) => {
    const body = await requestBody(c);
    if (body.type === "invalid") {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = userProfileCreateBodySchema.safeParse(body.body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);
    const result = await resolveApplicationPort(source, c).createUserProfile(
      toCreateUserProfileCommand(parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = userProfileResponseSchema.safeParse(
      toUserProfileResponse(result.profile),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid user profile"), 500);
    }
    return c.json(response.data, 201);
  });

  app.get("/", async (c) => {
    const query = userProfileListQuerySchema.safeParse({
      limit: c.req.query("limit"),
      page: c.req.query("page"),
      order: c.req.query("order"),
    });
    if (!query.success) return c.json(invalidField(query.error), 400);
    const result = await resolveApplicationPort(source, c).listUserProfiles(
      toListUserProfilesQuery(query.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    const response = userProfilePageResponseSchema.safeParse({
      data: result.page.profiles.map(toUserProfileResponse),
      next_page: result.page.nextCursor,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid user profile page"), 500);
    }
    return c.json(response.data, 200);
  });

  app.get("/:userProfileId", async (c) => {
    const result = await resolveApplicationPort(source, c).retrieveUserProfile({
      userProfileId: c.req.param("userProfileId"),
    });
    if (result.type === "not_found") {
      return c.json(
        notFound(`User profile ${c.req.param("userProfileId")} was not found`),
        404,
      );
    }
    const response = userProfileResponseSchema.safeParse(
      toUserProfileResponse(result.profile),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid user profile"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:userProfileId", async (c) => {
    const body = await requestBody(c);
    if (body.type === "invalid") {
      return c.json(invalidRequest("Request body must be valid JSON"), 400);
    }
    const parsed = userProfileUpdateBodySchema.safeParse(body.body);
    if (!parsed.success) return c.json(invalidField(parsed.error), 400);
    const result = await resolveApplicationPort(source, c).updateUserProfile(
      toUpdateUserProfileCommand(c.req.param("userProfileId"), parsed.data),
    );
    if (result.type === "invalid_request") {
      return c.json(invalidRequest(result.message), 400);
    }
    if (result.type === "version_conflict") {
      return c.json(conflict(result.message), 409);
    }
    if (result.type === "not_found") {
      return c.json(
        notFound(`User profile ${c.req.param("userProfileId")} was not found`),
        404,
      );
    }
    const response = userProfileResponseSchema.safeParse(
      toUserProfileResponse(result.profile),
    );
    if (!response.success) {
      return c.json(apiError("Application returned an invalid user profile"), 500);
    }
    return c.json(response.data, 200);
  });

  app.post("/:userProfileId/enrollment_url", async (c) => {
    const result = await resolveApplicationPort(source, c).createEnrollmentUrl({
      userProfileId: c.req.param("userProfileId"),
    });
    if (result.type === "not_found") {
      return c.json(
        notFound(`User profile ${c.req.param("userProfileId")} was not found`),
        404,
      );
    }
    if (result.type === "conflict") {
      return c.json(conflict(result.message), 409);
    }
    const response = enrollmentUrlResponseSchema.safeParse({
      expires_at: result.enrollment.expiresAt,
      type: "enrollment_url",
      url: result.enrollment.url,
    });
    if (!response.success) {
      return c.json(apiError("Application returned an invalid enrollment URL"), 500);
    }
    return c.json(response.data, 200);
  });

  return app;
}
