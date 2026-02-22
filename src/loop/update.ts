import { createHash } from "node:crypto";
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
const WHITESPACE_RE = /\s+/;

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

export const parseReleaseResponse = (data: unknown): ReleaseResponse => {
  if (typeof data !== "object" || data === null) {
    throw new Error("Invalid release response: expected an object");
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.tag_name !== "string") {
    throw new Error("Invalid release response: missing or invalid tag_name");
  }
  if (!Array.isArray(obj.assets)) {
    throw new Error("Invalid release response: missing or invalid assets");
  }
  for (const asset of obj.assets) {
    if (typeof asset !== "object" || asset === null) {
      throw new Error("Invalid release response: asset is not an object");
    }
    const a = asset as Record<string, unknown>;
    if (typeof a.name !== "string") {
      throw new Error("Invalid release response: asset missing name");
    }
    if (typeof a.browser_download_url !== "string") {
      throw new Error(
        "Invalid release response: asset missing browser_download_url"
      );
    }
  }
  return data as ReleaseResponse;
};

const fetchLatestRelease = async (): Promise<ReleaseResponse> => {
  const res = await fetch(API_URL, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}`);
  }
  return parseReleaseResponse(await res.json());
};

const verifyChecksum = async (
  data: Buffer,
  checksumUrl: string
): Promise<void> => {
  const res = await fetch(checksumUrl);
  if (!res.ok) {
    throw new Error(`Checksum download failed: HTTP ${res.status}`);
  }
  const expected = (await res.text()).trim().split(WHITESPACE_RE)[0];
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) {
    throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`);
  }
};

const downloadAndStage = async (
  url: string,
  version: string,
  checksumUrl?: string
): Promise<void> => {
  ensureCacheDir();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) {
    throw new Error("Downloaded file is empty");
  }

  if (checksumUrl) {
    await verifyChecksum(buf, checksumUrl);
  } else {
    console.error(
      "[loop] warning: no .sha256 checksum available, skipping verification"
    );
  }

  writeFileSync(STAGED_BINARY, buf);
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

const checkAndStage = async (
  assetName: string,
  silent: boolean
): Promise<void> => {
  const currentVersion = getCurrentVersion();
  const release = await fetchLatestRelease();
  const version = release.tag_name.replace(VERSION_PREFIX_RE, "");

  if (!isNewerVersion(version, currentVersion)) {
    if (!silent) {
      console.log(`[loop] already up to date (v${currentVersion})`);
    }
    return;
  }

  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(`No release asset for ${assetName}`);
  }

  if (!silent) {
    console.log(`[loop] downloading v${version}...`);
  }

  const checksumAsset = release.assets.find(
    (a) => a.name === `${assetName}.sha256`
  );
  await downloadAndStage(
    asset.browser_download_url,
    version,
    checksumAsset?.browser_download_url
  );

  if (!silent) {
    console.log(`[loop] v${version} staged — will apply on next startup`);
  }
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
    await checkAndStage(getAssetName(), false);
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

  let assetName: string;
  try {
    assetName = getAssetName();
    saveCheckTime();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[loop] auto-update skipped: ${msg}`);
    return;
  }

  checkAndStage(assetName, true).catch(() => {
    // Network/download failures are best-effort in auto mode
  });
};
