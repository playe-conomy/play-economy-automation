export function driveConfiguration() {
  return {
    rootFolderId: "1fHW2P2RAASkGXYzT7Cl2BvcrephFZn27",
    rootPath: "02_Biblioteca Visual",
    authentication: "Google Cloud Workload Identity Federation with GitHub Actions OIDC",
    configured: Boolean(process.env.GOOGLE_WORKLOAD_IDENTITY_PROVIDER && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL)
  };
}

export function driveDestination(candidate) {
  return resolveAssetDestination(candidate.assetRole, candidate).drivePath;
}

export function resolveAssetDestination(assetRole, metadata = {}) {
  const entity = metadata.entity ?? metadata.franchise ?? metadata.company ?? metadata.console ?? null;
  const folders = {
    specific: "Franquicias",
    gameplay: "Gameplay",
    company: "Empresas",
    console: "Consolas",
    character: "Personajes",
    official_art: "Arte Oficial",
    map: "Mapas"
  };
  if (assetRole === "technology" || assetRole === "contextual_broll") {
    return { finalCategory: "Tecnología", finalEntity: null, drivePath: "02_Biblioteca Visual/Tecnología/" };
  }
  if (assetRole === "playeconomy_graphic") {
    return { finalCategory: "Gráficos PLAYECONOMY", finalEntity: null, drivePath: "02_Biblioteca Visual/Gráficos PLAYECONOMY/" };
  }
  const finalCategory = folders[assetRole] ?? "Tecnología";
  const finalEntity = entity || null;
  const suffix = finalEntity ? `${finalEntity}/` : "";
  return { finalCategory, finalEntity, drivePath: `02_Biblioteca Visual/${finalCategory}/${suffix}` };
}

export async function uploadToDrive() {
  throw new Error("Drive upload is intentionally disabled until Google OIDC integration is configured. Dry runs never call this function.");
}
