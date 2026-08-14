export type AppConfig = {
  port: number;
  databaseUrl: string;
  jwtPrivateKey: string;
  jwtPublicKey: string;
  jwtIssuer: string;
  jwtAudience: string;
  internalApiKey: string;
  syncServerUrl: string;
  bootstrapUsername?: string;
  bootstrapPassword?: string;
  offlineAuthDays: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Required environment variable ${name} is not set`);
  return value.replace(/\\n/g, "\n");
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT || "3930"),
    databaseUrl: required("DATABASE_URL"),
    jwtPrivateKey: required("JWT_PRIVATE_KEY"),
    jwtPublicKey: required("JWT_PUBLIC_KEY"),
    jwtIssuer: process.env.JWT_ISSUER || "https://browser.sanheqiyun.xyz",
    jwtAudience: process.env.JWT_AUDIENCE || "sanhe-browser",
    internalApiKey: required("INTERNAL_API_KEY"),
    syncServerUrl:
      process.env.SYNC_SERVER_URL || "https://browser.sanheqiyun.xyz/sync",
    bootstrapUsername: process.env.BOOTSTRAP_SUPERADMIN_USERNAME,
    bootstrapPassword: process.env.BOOTSTRAP_SUPERADMIN_PASSWORD,
    offlineAuthDays: Number(process.env.OFFLINE_AUTH_DAYS || "7"),
  };
}
