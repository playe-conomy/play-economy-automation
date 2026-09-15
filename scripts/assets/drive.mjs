export function driveConfiguration() {
  return {
    rootFolderId: "1fHW2P2RAASkGXYzT7Cl2BvcrephFZn27",
    rootPath: "02_Biblioteca Visual",
    authentication: "Google Cloud Workload Identity Federation with GitHub Actions OIDC",
    configured: Boolean(process.env.GOOGLE_WORKLOAD_IDENTITY_PROVIDER && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL)
  };
}

export function driveDestination(candidate) {
  const group = candidate.category ?? "Gráficos PLAYECONOMY";
  const name = candidate.franchise ?? candidate.company ?? candidate.topic ?? "Unclassified";
  return `02_Biblioteca Visual/${group}/${name}/`;
}

export async function uploadToDrive() {
  throw new Error("Drive upload is intentionally disabled until Google OIDC integration is configured. Dry runs never call this function.");
}
