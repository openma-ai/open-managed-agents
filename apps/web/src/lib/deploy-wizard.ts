export type DeploymentTarget = "cloudflare" | "docker" | "fly" | "vercel" | "render";
export type ModelSetup = "console" | "environment";
export type DataMode = "managed" | "sqlite" | "postgres";

export interface DeploymentSelection {
  target: DeploymentTarget;
  modelSetup: ModelSetup;
  dataMode: DataMode;
}

export interface DeploymentTargetDefinition {
  name: string;
  eyebrow: string;
  availability: "ready" | "guided" | "planned";
  summary: string;
  note: string;
  estimate: string;
}

export interface DeploymentPlan {
  target: DeploymentTarget;
  name: string;
  status: string;
  topology: string;
  persistence: string;
  modelSetup: string;
  estimate: string;
  command: string;
  verificationCommand: string;
  requirements: string[];
  nextSteps: string[];
  launchUrl?: string;
  collectsSecrets: false;
}

export interface VercelDeploymentCallback {
  projectName: string;
  deploymentUrl: string;
  projectDashboardUrl?: string;
  deploymentDashboardUrl?: string;
  repositoryUrl?: string;
}

export interface DeploymentPlanOptions {
  vercelRedirectUrl?: string;
}

export const DEPLOYMENT_TARGETS: Record<DeploymentTarget, DeploymentTargetDefinition> = {
  cloudflare: {
    name: "Cloudflare",
    eyebrow: "Recommended",
    availability: "ready",
    summary: "The complete edge topology, provisioned in your account.",
    note: "Three Workers, Durable Objects, Containers, D1, KV, R2, and Queue.",
    estimate: "≈ 10 min",
  },
  docker: {
    name: "Docker",
    eyebrow: "Fastest",
    availability: "ready",
    summary: "A durable Node deployment for one host or private network.",
    note: "Interactive setup, generated secrets, and persistent Docker volumes.",
    estimate: "≈ 10 min",
  },
  fly: {
    name: "Fly.io",
    eyebrow: "Ready",
    availability: "ready",
    summary: "Run the Node topology on Fly Machines with a persistent volume.",
    note: "Fly Launch reads the checked-in Machine adapter and provisions its first volume.",
    estimate: "≈ 8 min",
  },
  render: {
    name: "Render",
    eyebrow: "Template",
    availability: "guided",
    summary: "Deploy a persistent Node service from a Render Blueprint.",
    note: "Paid service and disk, generated application secrets, and your E2B key.",
    estimate: "≈ 15 min",
  },
  vercel: {
    name: "Vercel",
    eyebrow: "Beta",
    availability: "guided",
    summary: "A bounded serverless control plane with the agent loop inside Sandbox.",
    note: "Vercel provisions Neon Postgres; object storage stays explicit; Sandbox executes claimed Work.",
    estimate: "≈ 15 min",
  },
};

const REPOSITORY_SETUP = `git clone https://github.com/openma-ai/open-managed-agents.git
cd open-managed-agents`;

const OPENMA_REPOSITORY_URL = "https://github.com/openma-ai/open-managed-agents";
const DEFAULT_VERCEL_REDIRECT_URL = "https://openma.dev/deploy/?provider=vercel&phase=callback";
const VERCEL_ENVIRONMENT_KEYS = [
  "BETTER_AUTH_SECRET",
  "PLATFORM_ROOT_SECRET",
  "MEMORY_S3_ENDPOINT",
  "MEMORY_S3_BUCKET",
  "MEMORY_S3_ACCESS_KEY",
  "MEMORY_S3_SECRET_KEY",
  "FILES_S3_ENDPOINT",
  "FILES_S3_BUCKET",
  "FILES_S3_ACCESS_KEY",
  "FILES_S3_SECRET_KEY",
] as const;

function modelSetupLabel(modelSetup: ModelSetup): string {
  return modelSetup === "console"
    ? "Add a Model Card after sign-in (recommended)"
    : "Set a provider key in the deployment environment";
}

const TARGET_IDS = new Set<DeploymentTarget>(["cloudflare", "docker", "fly", "vercel", "render"]);
const MODEL_SETUP_IDS = new Set<ModelSetup>(["console", "environment"]);
const DATA_MODE_IDS = new Set<DataMode>(["managed", "sqlite", "postgres"]);

export function parseDeploymentTarget(params: URLSearchParams): DeploymentTarget | null {
  const value = params.get("provider");
  return value && TARGET_IDS.has(value as DeploymentTarget) ? value as DeploymentTarget : null;
}

export function serializeBrowserSelection(selection: DeploymentSelection): string {
  return JSON.stringify(selection);
}

export function parseBrowserSelection(value: string | null): DeploymentSelection | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<DeploymentSelection>;
    if (
      typeof parsed.target !== "string" ||
      typeof parsed.modelSetup !== "string" ||
      typeof parsed.dataMode !== "string" ||
      !TARGET_IDS.has(parsed.target as DeploymentTarget) ||
      !MODEL_SETUP_IDS.has(parsed.modelSetup as ModelSetup) ||
      !DATA_MODE_IDS.has(parsed.dataMode as DataMode)
    ) {
      return null;
    }
    return parsed as DeploymentSelection;
  } catch {
    return null;
  }
}

function parseSafeWebUrl(value: string | null, allowLocalHttp = false): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    const isLocalHttp = allowLocalHttp
      && url.protocol === "http:"
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (url.protocol !== "https:" && !isLocalHttp) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function buildVercelDeployButtonUrl(
  options: { redirectUrl?: string } = {},
): string {
  const redirectUrl = parseSafeWebUrl(options.redirectUrl ?? DEFAULT_VERCEL_REDIRECT_URL, true);
  if (!redirectUrl) {
    throw new TypeError("Vercel redirect URL must use HTTPS, except for localhost development");
  }

  const url = new URL("https://vercel.com/new/clone");
  url.searchParams.set("repository-url", OPENMA_REPOSITORY_URL);
  url.searchParams.set("project-name", "openma");
  url.searchParams.set("repository-name", "openma");
  url.searchParams.set("redirect-url", redirectUrl);
  url.searchParams.set("products", JSON.stringify([{
    type: "integration",
    protocol: "storage",
    productSlug: "neon",
    integrationSlug: "neon",
  }]));
  url.searchParams.set("env", VERCEL_ENVIRONMENT_KEYS.join(","));
  url.searchParams.set(
    "envDescription",
    "Postgres is provisioned through Neon. Add S3-compatible object storage and OpenMA secrets directly in Vercel; values never pass through openma.dev.",
  );
  url.searchParams.set("envLink", "https://openma.dev/deploy/");
  return url.toString();
}

export function parseVercelDeploymentCallback(
  params: URLSearchParams,
): VercelDeploymentCallback | null {
  if (params.get("provider") !== "vercel" || params.get("phase") !== "callback") return null;

  const projectName = params.get("project-name")?.trim() ?? "";
  if (!projectName || projectName.length > 128 || /[\u0000-\u001f\u007f]/u.test(projectName)) return null;

  const deploymentUrl = parseSafeWebUrl(params.get("deployment-url"));
  if (!deploymentUrl) return null;

  const optionalUrl = (key: string): string | undefined | null => {
    const raw = params.get(key);
    if (!raw) return undefined;
    return parseSafeWebUrl(raw);
  };
  const projectDashboardUrl = optionalUrl("project-dashboard-url");
  const deploymentDashboardUrl = optionalUrl("deployment-dashboard-url");
  const repositoryUrl = optionalUrl("repository-url");
  if (projectDashboardUrl === null || deploymentDashboardUrl === null || repositoryUrl === null) return null;

  return {
    projectName,
    deploymentUrl,
    ...(projectDashboardUrl && { projectDashboardUrl }),
    ...(deploymentDashboardUrl && { deploymentDashboardUrl }),
    ...(repositoryUrl && { repositoryUrl }),
  };
}

export function buildDeploymentPlan(
  selection: DeploymentSelection,
  options: DeploymentPlanOptions = {},
): DeploymentPlan {
  const target = DEPLOYMENT_TARGETS[selection.target];
  const common = {
    target: selection.target,
    name: target.name,
    estimate: target.estimate,
    modelSetup: modelSetupLabel(selection.modelSetup),
    collectsSecrets: false as const,
  };

  if (selection.target === "cloudflare") {
    return {
      ...common,
      status: "Ready",
      topology: "3 Workers · Durable Objects · Containers · D1 · KV · R2",
      persistence: "D1 for state, R2 for files/workspaces, KV for configuration",
      command: `${REPOSITORY_SETUP}
pnpm install
pnpm setup:cloudflare`,
      verificationCommand: "curl https://<your-main-worker>.workers.dev/health",
      requirements: [
        "Cloudflare Workers Paid plan",
        "Node.js 24+ and pnpm",
        "Wrangler login in the terminal that runs the wizard",
      ],
      nextSteps: [
        "The CLI provisions resources and deploys all three Workers in dependency order.",
        "Open the main Worker URL and create the first workspace owner.",
        "Add a Model Card in Console; no model key is sent through openma.dev.",
      ],
    };
  }

  if (selection.target === "docker") {
    return {
      ...common,
      status: "Ready",
      topology: selection.dataMode === "postgres" ? "Node server · Postgres" : "Node server · SQLite",
      persistence: "Named Docker volumes for durable database, files, outputs, and sandbox state",
      command: `${REPOSITORY_SETUP}
OPENMA_DOCKER_DATA_MODE=${selection.dataMode === "postgres" ? "postgres" : "sqlite"} bash scripts/setup-docker.sh`,
      verificationCommand: "curl http://localhost:8787/health",
      requirements: [
        "Docker Engine/Desktop with Compose v2.24+, Git, Bash, and openssl",
        "Credentials for an isolated sandbox provider: E2B, Daytona, or BoxRun",
        "Disk space for the source build and persistent Docker volumes",
      ],
      nextSteps: [
        "Choose an isolated sandbox provider in the terminal; the wizard securely prompts for its credentials.",
        "The subprocess adapter is not available; select an isolated sandbox provider.",
        "Application secrets are generated locally in .env.openma; repeated runs preserve them.",
        "The first source build can take several minutes. Setup waits until /health responds.",
        "Open http://localhost:8787, create your account, and add a Model Card in Console.",
        "For a VPS, configure an HTTPS reverse proxy and OPENMA_DOCKER_PUBLIC_URL before sharing access.",
      ],
    };
  }

  if (selection.target === "render") {
    return {
      ...common,
      status: "Template",
      topology: "One Node service · SQLite · E2B sandboxes",
      persistence: "Persistent disk mounted at /app/data; keep the service at one instance",
      command: "# Use Deploy with Render below to create a Blueprint from render.yaml.\n# Enter E2B_API_KEY directly in Render and review the service and disk charges.",
      verificationCommand: "curl https://<your-service>.onrender.com/health",
      launchUrl: `https://render.com/deploy?repo=${encodeURIComponent(OPENMA_REPOSITORY_URL)}`,
      requirements: ["A Render account with billing enabled for a paid service and persistent disk", "E2B_API_KEY entered directly in Render", "Review region, service size, and disk capacity before deploying"],
      nextSteps: [
        "Render builds the repository, generates application secrets, and mounts the persistent disk.",
        "The service uses its Render URL automatically; set PUBLIC_BASE_URL when adding a custom domain.",
        "Open your service URL, create your account, and add a Model Card in Console.",
        "Automatic deploys are disabled; deploy updates explicitly and back up the disk.",
      ],
    };
  }

  if (selection.target === "fly") {
    return {
      ...common,
      status: "Ready",
      topology: "Fly Machine · Node control plane · portable sandbox drivers",
      persistence: "Fly Volume mounted at /app/data for SQLite, files, outputs, workspaces, and native harness state",
      command: `${REPOSITORY_SETUP}
fly auth login
# setup:fly resolves this checkout to its immutable Git-SHA release checkpoint image.
# E2B example; use Daytona or BoxRun plus its matching configuration if preferred.
E2B_API_KEY=... OPENMA_FLY_DATA_MODE=${selection.dataMode === "postgres" ? "postgres" : "sqlite"} OPENMA_FLY_SANDBOX_PROVIDER=e2b bash scripts/setup-fly.sh`,
      verificationCommand: "fly checks list && curl https://<your-app>.fly.dev/health",
      requirements: [
        "A Fly.io account and flyctl",
        selection.dataMode === "postgres"
          ? "Review Fly Managed Postgres billing and choose its region"
          : "Keep the SQLite deployment at one Machine",
        "Credentials and configuration for an isolated sandbox provider",
        "Review generated secrets and Machine/volume billing in Fly",
      ],
      nextSteps: [
        "fly.toml initial_size provisions and mounts the first /app/data volume; daily snapshots are retained for 14 days.",
        "The main-fly adapter derives the public origin from FLY_APP_NAME before the portable Node app starts.",
        "The setup script maps the checkout's full Git SHA to an immutable GHCR server image, so Fly pulls a release checkpoint instead of rebuilding the monorepo.",
        "If this checkout has no published image, use OPENMA_FLY_BUILD_FROM_SOURCE=1 or select a published digest.",
        "Pin OPENMA_FLY_IMAGE to an explicit sha256 digest when promoting an audited release.",
        "The setup script generates application secrets locally, stages them directly in Fly, deploys, and runs health checks.",
        "The subprocess adapter is not available in deployable entrypoints; Fly fails closed until an isolated provider is configured.",
      ],
    };
  }

  return {
    ...common,
    status: "Beta",
    topology: "Bounded Function webhook/poll · external Postgres · object storage · Vercel Sandbox",
    persistence: "External Postgres for session/event/lease state; object storage and Sandbox snapshots for durable files and workspaces",
    command: `${REPOSITORY_SETUP}
pnpm install
# Configure the required Vercel environment variables in your project first.
pnpm build:vercel
pnpm dlx vercel@59.15.1 deploy --local-config vercel.json`,
    verificationCommand: "curl https://<your-project>.vercel.app/health",
    launchUrl: buildVercelDeployButtonUrl({ redirectUrl: options.vercelRedirectUrl }),
    requirements: [
      "Confirm the Neon Postgres product and its billing/region in Vercel",
      "Object storage plus a remotely reachable vault egress gateway",
      "A Vercel Sandbox snapshot containing the selected ACP harness worker",
      "Environment ID/key, signed-webhook secret, and CRON_SECRET configured in Vercel",
    ],
    nextSteps: [
      "Vercel provisions Neon Postgres and injects DATABASE_URL during project creation.",
      "The Function only accepts API traffic, signed webhook wakeups, and bounded fallback polls.",
      "The scoped Work token enters Sandbox; the standing Environment key stays in the Function.",
      "Run the credentialed Sandbox E2E and provider-chaos lane before promoting a production deployment.",
    ],
  };
}
