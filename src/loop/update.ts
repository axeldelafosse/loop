import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import pkg from "../../package.json";

const GITHUB_REPO = "axeldelafosse/loop";
const API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const CACHE_DIR = join(homedir(), ".cache", "loop", "update");
const STAGED_BINARY = join(CACHE_DIR, "loop-staged");
const METADATA_FILE = join(CACHE_DIR, "metadata.json");
const CHECK_FILE = join(CACHE_DIR, "last-check.json");
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const VERSION_PREFIX_RE = /^v/;

interface UpdateMetadata {
  downloadedAt: string;
  sourceUrl: string;
  targetVersion: string;
}

interface ReleaseAsset {
  browser_download_url: string;
  name: string;
}

interface ReleaseResponse {
  assets: ReleaseAsset[];
  tag_name: string;
}

export const getCurrentVersion = (): string => pkg.version;

export const isNewerVersion = (remote: string, current: string): boolean => {
  const r = remote.replace(VERSION_PREFIX_RE, "").split(".").map(Number);
  const c = current.replace(VERSION_PREFIX_RE, "").split(".").map(Number);
  for (let i = 0; i < Math.max(r.length, c.length); i++) {
    if ((r[i] ?? 0) > (c[i] ?? 0)) {
      return true;
    }
    if ((r[i] ?? 0) < (c[i] ?? 0)) {
      return false;
    }
  }
  return false;
};

const OS_MAP: Record<string, string> = { darwin: "macos", linux: "linux" };
const ARCH_MAP: Record<string, string> = { arm64: "arm64", x64: "x64" };

export const getAssetName = (): string => {
  const os = OS_MAP[process.platform];
  if (!os) {
    throw new Error(`Unsupported OS: ${process.platform}`);
  }
  const arch = ARCH_MAP[process.arch];
  if (!arch) {
    throw new Error(`Unsupported architecture: ${process.arch}`);
  }
  return `loop-${os}-${arch}`;
};

export const isDevMode = (): boolean => {
  const name = basename(process.execPath);
  return name === "bun" || name === "node";
};

const ensureCacheDir = (): void => {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
};

const shouldThrottle = (): boolean => {
  if (!existsSync(CHECK_FILE)) {
    return false;
  }
  try {
    const data = JSON.parse(readFileSync(CHECK_FILE, "utf-8"));
    return Date.now() - new Date(data.lastCheck).getTime() < CHECK_INTERVAL_MS;
  } catch {
    return false;
  }
};

const saveCheckTime = (): void => {
  ensureCacheDir();
  writeFileSync(
    CHECK_FILE,
    JSON.stringify({ lastCheck: new Date().toISOString() })
  );
};

const fetchLatestRelease = async (): Promise<ReleaseResponse> => {
  const res = await fetch(API_URL, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}`);
  }
  return (await res.json()) as ReleaseResponse;
};

const downloadAndStage = async (
  url: string,
  version: string
): Promise<void> => {
  ensureCacheDir();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error("Downloaded file is empty");
  }

  writeFileSync(STAGED_BINARY, Buffer.from(buffer));
  chmodSync(STAGED_BINARY, 0o755);

  const metadata: UpdateMetadata = {
    downloadedAt: new Date().toISOString(),
    sourceUrl: url,
    targetVersion: version,
  };
  writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
};

export const applyStagedUpdateOnStartup = (): Promise<void> => {
  if (isDevMode()) {
    return Promise.resolve();
  }
  if (!(existsSync(STAGED_BINARY) && existsSync(METADATA_FILE))) {
    return Promise.resolve();
  }

  try {
    const metadata: UpdateMetadata = JSON.parse(
      readFileSync(METADATA_FILE, "utf-8")
    );
    const execPath = process.execPath;
    const tmpPath = `${execPath}.tmp-${Date.now()}`;

    writeFileSync(tmpPath, readFileSync(STAGED_BINARY));
    chmodSync(tmpPath, 0o755);
    renameSync(tmpPath, execPath);

    unlinkSync(STAGED_BINARY);
    unlinkSync(METADATA_FILE);

    console.log(`[loop] updated to v${metadata.targetVersion}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[loop] failed to apply staged update: ${msg}`);
  }
  return Promise.resolve();
};

const runUpdateFlow = async (): Promise<void> => {
  const currentVersion = getCurrentVersion();
  const assetName = getAssetName();
  const release = await fetchLatestRelease();
  const version = release.tag_name.replace(VERSION_PREFIX_RE, "");

  if (!isNewerVersion(version, currentVersion)) {
    console.log(`[loop] already up to date (v${currentVersion})`);
    return;
  }

  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(`No release asset for ${assetName}`);
  }

  console.log(`[loop] downloading v${version}...`);
  await downloadAndStage(asset.browser_download_url, version);
  console.log(`[loop] v${version} staged — will apply on next startup`);
};

export const handleManualUpdateCommand = async (
  argv: string[]
): Promise<boolean> => {
  const cmd = argv[0]?.toLowerCase();
  if (cmd !== "update" && cmd !== "upgrade") {
    return false;
  }

  if (isDevMode()) {
    console.log("[loop] running from source — use git pull to update");
    return true;
  }

  try {
    await runUpdateFlow();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[loop] update failed: ${msg}`);
  }
  return true;
};

export const startAutoUpdateCheck = (): void => {
  if (isDevMode()) {
    return;
  }
  if (shouldThrottle()) {
    return;
  }

  // Validate platform and persist check time synchronously.
  // These are local/actionable errors — report them to the user.
  let assetName: string;
  try {
    assetName = getAssetName();
    saveCheckTime();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[loop] auto-update skipped: ${msg}`);
    return;
  }

  (async () => {
    try {
      const currentVersion = getCurrentVersion();
      const release = await fetchLatestRelease();
      const version = release.tag_name.replace(VERSION_PREFIX_RE, "");

      if (!isNewerVersion(version, currentVersion)) {
        return;
      }

      const asset = release.assets.find((a) => a.name === assetName);
      if (!asset) {
        return;
      }

      await downloadAndStage(asset.browser_download_url, version);
    } catch {
      // Network and download failures are best-effort in auto mode
    }
  })();
};
