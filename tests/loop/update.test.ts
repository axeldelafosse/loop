import { afterEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const CACHE_DIR = join(homedir(), ".cache", "loop", "update");
const STAGED_BINARY = join(CACHE_DIR, "loop-staged");
const METADATA_FILE = join(CACHE_DIR, "metadata.json");
const CHECK_FILE = join(CACHE_DIR, "last-check.json");

const ASSET_NAME_RE = /^loop-(macos|linux)-(x64|arm64)$/;
const SEMVER_RE = /^\d+\.\d+\.\d+/;

afterEach(() => {
  mock.restore();
});

// --- isNewerVersion ---

test("isNewerVersion returns true when remote is newer (patch)", async () => {
  const { isNewerVersion } = await import("../../src/loop/update");
  expect(isNewerVersion("1.0.3", "1.0.2")).toBe(true);
});

test("isNewerVersion returns true when remote is newer (minor)", async () => {
  const { isNewerVersion } = await import("../../src/loop/update");
  expect(isNewerVersion("1.1.0", "1.0.9")).toBe(true);
});

test("isNewerVersion returns true when remote is newer (major)", async () => {
  const { isNewerVersion } = await import("../../src/loop/update");
  expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
});

test("isNewerVersion returns false when versions are equal", async () => {
  const { isNewerVersion } = await import("../../src/loop/update");
  expect(isNewerVersion("1.0.2", "1.0.2")).toBe(false);
});

test("isNewerVersion returns false when remote is older", async () => {
  const { isNewerVersion } = await import("../../src/loop/update");
  expect(isNewerVersion("1.0.1", "1.0.2")).toBe(false);
});

test("isNewerVersion strips v prefix", async () => {
  const { isNewerVersion } = await import("../../src/loop/update");
  expect(isNewerVersion("v1.0.3", "v1.0.2")).toBe(true);
  expect(isNewerVersion("v1.0.2", "1.0.2")).toBe(false);
});

// --- getAssetName ---

test("getAssetName returns platform-specific name", async () => {
  const { getAssetName } = await import("../../src/loop/update");
  const name = getAssetName();
  expect(name).toMatch(ASSET_NAME_RE);
});

// --- isDevMode ---

test("isDevMode returns true when execPath ends with bun", async () => {
  const original = process.execPath;
  try {
    Object.defineProperty(process, "execPath", { value: "/usr/bin/bun" });
    const { isDevMode } = await import(
      `../../src/loop/update?dev=${Date.now()}`
    );
    expect(isDevMode()).toBe(true);
  } finally {
    Object.defineProperty(process, "execPath", { value: original });
  }
});

test("isDevMode returns false when execPath is loop binary", async () => {
  const original = process.execPath;
  try {
    Object.defineProperty(process, "execPath", {
      value: "/home/user/.local/bin/loop",
    });
    const { isDevMode } = await import(
      `../../src/loop/update?bin=${Date.now()}`
    );
    expect(isDevMode()).toBe(false);
  } finally {
    Object.defineProperty(process, "execPath", { value: original });
  }
});

// --- handleManualUpdateCommand ---

test("handleManualUpdateCommand returns true for update", async () => {
  const { handleManualUpdateCommand } = await import("../../src/loop/update");
  const result = await handleManualUpdateCommand(["update"]);
  expect(result).toBe(true);
});

test("handleManualUpdateCommand returns true for upgrade", async () => {
  const { handleManualUpdateCommand } = await import("../../src/loop/update");
  const result = await handleManualUpdateCommand(["upgrade"]);
  expect(result).toBe(true);
});

test("handleManualUpdateCommand returns false for other commands", async () => {
  const { handleManualUpdateCommand } = await import("../../src/loop/update");
  expect(await handleManualUpdateCommand(["--help"])).toBe(false);
  expect(await handleManualUpdateCommand(["some-task"])).toBe(false);
  expect(await handleManualUpdateCommand([])).toBe(false);
});

// --- applyStagedUpdateOnStartup ---

test("applyStagedUpdateOnStartup skips when no staged binary", async () => {
  const logMock = mock(() => undefined);
  const originalLog = console.log;
  console.log = logMock;

  try {
    if (existsSync(STAGED_BINARY)) {
      unlinkSync(STAGED_BINARY);
    }
    if (existsSync(METADATA_FILE)) {
      unlinkSync(METADATA_FILE);
    }

    const { applyStagedUpdateOnStartup } = await import(
      `../../src/loop/update?noop=${Date.now()}`
    );
    await applyStagedUpdateOnStartup();

    expect(logMock).not.toHaveBeenCalled();
  } finally {
    console.log = originalLog;
  }
});

// --- startAutoUpdateCheck ---

test("startAutoUpdateCheck does not block", async () => {
  const { startAutoUpdateCheck } = await import("../../src/loop/update");
  const start = Date.now();
  startAutoUpdateCheck();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(50);
});

// --- throttle behavior ---

test("auto-check respects throttle interval", async () => {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(
    CHECK_FILE,
    JSON.stringify({ lastCheck: new Date().toISOString() })
  );

  const fetchMock = mock(() =>
    Promise.resolve(Response.json({ tag_name: "v99.0.0", assets: [] }))
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;

  try {
    const { startAutoUpdateCheck } = await import(
      `../../src/loop/update?throttle=${Date.now()}`
    );
    startAutoUpdateCheck();

    await new Promise((r) => setTimeout(r, 100));
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
    if (existsSync(CHECK_FILE)) {
      unlinkSync(CHECK_FILE);
    }
  }
});

// --- getCurrentVersion ---

test("getCurrentVersion returns a valid semver string", async () => {
  const { getCurrentVersion } = await import("../../src/loop/update");
  const version = getCurrentVersion();
  expect(version).toMatch(SEMVER_RE);
});

// --- getAssetName unsupported platform/arch ---

test("getAssetName throws for unsupported OS", async () => {
  const original = process.platform;
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  try {
    const { getAssetName } = await import(
      `../../src/loop/update?platwin=${Date.now()}`
    );
    expect(() => getAssetName()).toThrow("Unsupported OS: win32");
  } finally {
    Object.defineProperty(process, "platform", {
      value: original,
      configurable: true,
    });
  }
});

test("getAssetName throws for unsupported architecture", async () => {
  const origArch = process.arch;
  Object.defineProperty(process, "arch", {
    value: "mips",
    configurable: true,
  });
  try {
    const { getAssetName } = await import(
      `../../src/loop/update?archmips=${Date.now()}`
    );
    expect(() => getAssetName()).toThrow("Unsupported architecture: mips");
  } finally {
    Object.defineProperty(process, "arch", {
      value: origArch,
      configurable: true,
    });
  }
});

// --- applyStagedUpdateOnStartup apply success ---

test("applyStagedUpdateOnStartup applies staged binary and cleans up", async () => {
  const testDir = join(tmpdir(), `loop-apply-test-${Date.now()}`);
  const fakeExec = join(testDir, "loop");
  mkdirSync(testDir, { recursive: true });
  writeFileSync(fakeExec, "old-binary");

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(STAGED_BINARY, "new-binary");
  writeFileSync(
    METADATA_FILE,
    JSON.stringify({
      targetVersion: "2.0.0",
      downloadedAt: new Date().toISOString(),
      sourceUrl: "https://example.com/loop",
    })
  );

  const originalExecPath = process.execPath;
  const logMock = mock(() => undefined);
  const originalLog = console.log;

  Object.defineProperty(process, "execPath", {
    value: fakeExec,
    configurable: true,
  });
  console.log = logMock;

  try {
    const { applyStagedUpdateOnStartup } = await import(
      `../../src/loop/update?apply=${Date.now()}`
    );
    await applyStagedUpdateOnStartup();

    expect(readFileSync(fakeExec, "utf-8")).toBe("new-binary");
    expect(existsSync(STAGED_BINARY)).toBe(false);
    expect(existsSync(METADATA_FILE)).toBe(false);
    expect(logMock).toHaveBeenCalledWith("[loop] updated to v2.0.0");
  } finally {
    Object.defineProperty(process, "execPath", {
      value: originalExecPath,
      configurable: true,
    });
    console.log = originalLog;
    rmSync(testDir, { recursive: true, force: true });
    if (existsSync(STAGED_BINARY)) {
      unlinkSync(STAGED_BINARY);
    }
    if (existsSync(METADATA_FILE)) {
      unlinkSync(METADATA_FILE);
    }
  }
});

// --- applyStagedUpdateOnStartup permission failure ---

test("applyStagedUpdateOnStartup logs error on write failure", async () => {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(STAGED_BINARY, "new-binary");
  writeFileSync(
    METADATA_FILE,
    JSON.stringify({
      targetVersion: "3.0.0",
      downloadedAt: new Date().toISOString(),
      sourceUrl: "https://example.com/loop",
    })
  );

  const originalExecPath = process.execPath;
  const errorMock = mock(() => undefined);
  const originalError = console.error;

  // Point execPath to an unwritable system directory
  Object.defineProperty(process, "execPath", {
    value: "/usr/bin/loop-update-test-fake",
    configurable: true,
  });
  console.error = errorMock;

  try {
    const { applyStagedUpdateOnStartup } = await import(
      `../../src/loop/update?permfail=${Date.now()}`
    );
    await applyStagedUpdateOnStartup();

    expect(errorMock).toHaveBeenCalledTimes(1);
    const msg = errorMock.mock.calls[0][0] as string;
    expect(msg).toContain("[loop] failed to apply staged update:");
  } finally {
    Object.defineProperty(process, "execPath", {
      value: originalExecPath,
      configurable: true,
    });
    console.error = originalError;
    if (existsSync(STAGED_BINARY)) {
      unlinkSync(STAGED_BINARY);
    }
    if (existsSync(METADATA_FILE)) {
      unlinkSync(METADATA_FILE);
    }
  }
});

// --- handleManualUpdateCommand staging ---

test("handleManualUpdateCommand stages update with correct metadata", async () => {
  const osName = process.platform === "darwin" ? "macos" : "linux";
  const assetName = `loop-${osName}-${process.arch}`;

  const originalExecPath = process.execPath;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;

  Object.defineProperty(process, "execPath", {
    value: "/tmp/loop-update-test-binary",
    configurable: true,
  });

  const fetchMock = mock((...args: unknown[]) => {
    const url = String(args[0]);
    if (url.includes("api.github.com")) {
      return Promise.resolve(
        Response.json({
          tag_name: "v99.0.0",
          assets: [
            {
              name: assetName,
              browser_download_url: "https://example.com/loop-binary",
            },
          ],
        })
      );
    }
    return Promise.resolve(new Response("fake-binary-data"));
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const logMock = mock(() => undefined);
  console.log = logMock;

  try {
    const { handleManualUpdateCommand } = await import(
      `../../src/loop/update?staging=${Date.now()}`
    );
    await handleManualUpdateCommand(["update"]);

    expect(existsSync(STAGED_BINARY)).toBe(true);
    expect(existsSync(METADATA_FILE)).toBe(true);

    const metadata = JSON.parse(readFileSync(METADATA_FILE, "utf-8"));
    expect(metadata.targetVersion).toBe("99.0.0");
    expect(metadata.sourceUrl).toBe("https://example.com/loop-binary");
    expect(metadata.downloadedAt).toBeTruthy();
  } finally {
    Object.defineProperty(process, "execPath", {
      value: originalExecPath,
      configurable: true,
    });
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (existsSync(STAGED_BINARY)) {
      unlinkSync(STAGED_BINARY);
    }
    if (existsSync(METADATA_FILE)) {
      unlinkSync(METADATA_FILE);
    }
  }
});

// --- parseReleaseResponse ---

test("parseReleaseResponse accepts valid input", async () => {
  const { parseReleaseResponse } = await import("../../src/loop/update");
  const result = parseReleaseResponse({
    tag_name: "v1.0.0",
    assets: [
      {
        name: "loop-macos-arm64",
        browser_download_url: "https://example.com/binary",
      },
    ],
  });
  expect(result.tag_name).toBe("v1.0.0");
  expect(result.assets).toHaveLength(1);
});

test("parseReleaseResponse throws for non-object", async () => {
  const { parseReleaseResponse } = await import("../../src/loop/update");
  expect(() => parseReleaseResponse("not an object")).toThrow(
    "expected an object"
  );
  expect(() => parseReleaseResponse(null)).toThrow("expected an object");
});

test("parseReleaseResponse throws for missing tag_name", async () => {
  const { parseReleaseResponse } = await import("../../src/loop/update");
  expect(() => parseReleaseResponse({ assets: [] })).toThrow(
    "missing or invalid tag_name"
  );
});

test("parseReleaseResponse throws for missing assets", async () => {
  const { parseReleaseResponse } = await import("../../src/loop/update");
  expect(() => parseReleaseResponse({ tag_name: "v1.0.0" })).toThrow(
    "missing or invalid assets"
  );
});

test("parseReleaseResponse throws for asset missing name", async () => {
  const { parseReleaseResponse } = await import("../../src/loop/update");
  expect(() =>
    parseReleaseResponse({
      tag_name: "v1.0.0",
      assets: [{ browser_download_url: "https://example.com" }],
    })
  ).toThrow("asset missing name");
});

test("parseReleaseResponse throws for asset missing browser_download_url", async () => {
  const { parseReleaseResponse } = await import("../../src/loop/update");
  expect(() =>
    parseReleaseResponse({
      tag_name: "v1.0.0",
      assets: [{ name: "loop-macos-arm64" }],
    })
  ).toThrow("asset missing browser_download_url");
});

// --- SHA-256 checksum verification ---

test("update verifies matching checksum", async () => {
  const binaryData = "fake-binary-data";
  const expectedHash = createHash("sha256").update(binaryData).digest("hex");

  const osName = process.platform === "darwin" ? "macos" : "linux";
  const assetName = `loop-${osName}-${process.arch}`;

  const originalExecPath = process.execPath;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;

  Object.defineProperty(process, "execPath", {
    value: "/tmp/loop-checksum-test-binary",
    configurable: true,
  });

  const fetchMock = mock((...args: unknown[]) => {
    const url = String(args[0]);
    if (url.includes("api.github.com")) {
      return Promise.resolve(
        Response.json({
          tag_name: "v99.0.0",
          assets: [
            {
              name: assetName,
              browser_download_url: "https://example.com/loop-binary",
            },
            {
              name: `${assetName}.sha256`,
              browser_download_url: "https://example.com/loop-binary.sha256",
            },
          ],
        })
      );
    }
    if (url.includes(".sha256")) {
      return Promise.resolve(new Response(`${expectedHash}  ${assetName}\n`));
    }
    return Promise.resolve(new Response(binaryData));
  });
  globalThis.fetch = fetchMock as typeof fetch;

  console.log = mock(() => undefined);
  console.error = mock(() => undefined);

  try {
    const { handleManualUpdateCommand } = await import(
      `../../src/loop/update?checksum=${Date.now()}`
    );
    await handleManualUpdateCommand(["update"]);

    expect(existsSync(STAGED_BINARY)).toBe(true);
    expect(existsSync(METADATA_FILE)).toBe(true);
  } finally {
    Object.defineProperty(process, "execPath", {
      value: originalExecPath,
      configurable: true,
    });
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    if (existsSync(STAGED_BINARY)) {
      unlinkSync(STAGED_BINARY);
    }
    if (existsSync(METADATA_FILE)) {
      unlinkSync(METADATA_FILE);
    }
  }
});

test("update rejects mismatched checksum", async () => {
  const osName = process.platform === "darwin" ? "macos" : "linux";
  const assetName = `loop-${osName}-${process.arch}`;

  const originalExecPath = process.execPath;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;

  Object.defineProperty(process, "execPath", {
    value: "/tmp/loop-checksum-test-binary",
    configurable: true,
  });

  const fetchMock = mock((...args: unknown[]) => {
    const url = String(args[0]);
    if (url.includes("api.github.com")) {
      return Promise.resolve(
        Response.json({
          tag_name: "v99.0.0",
          assets: [
            {
              name: assetName,
              browser_download_url: "https://example.com/loop-binary",
            },
            {
              name: `${assetName}.sha256`,
              browser_download_url: "https://example.com/loop-binary.sha256",
            },
          ],
        })
      );
    }
    if (url.includes(".sha256")) {
      return Promise.resolve(
        new Response(
          "0000000000000000000000000000000000000000000000000000000000000000  loop\n"
        )
      );
    }
    return Promise.resolve(new Response("fake-binary-data"));
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const errorMock = mock(() => undefined);
  console.log = mock(() => undefined);
  console.error = errorMock;

  try {
    const { handleManualUpdateCommand } = await import(
      `../../src/loop/update?badchecksum=${Date.now()}`
    );
    await handleManualUpdateCommand(["update"]);

    const errorCalls = errorMock.mock.calls.map((c) => String(c[0]));
    expect(errorCalls.some((msg) => msg.includes("Checksum mismatch"))).toBe(
      true
    );
    expect(existsSync(STAGED_BINARY)).toBe(false);
  } finally {
    Object.defineProperty(process, "execPath", {
      value: originalExecPath,
      configurable: true,
    });
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    if (existsSync(STAGED_BINARY)) {
      unlinkSync(STAGED_BINARY);
    }
    if (existsSync(METADATA_FILE)) {
      unlinkSync(METADATA_FILE);
    }
  }
});

test("update warns when no checksum available", async () => {
  const osName = process.platform === "darwin" ? "macos" : "linux";
  const assetName = `loop-${osName}-${process.arch}`;

  const originalExecPath = process.execPath;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;

  Object.defineProperty(process, "execPath", {
    value: "/tmp/loop-checksum-test-binary",
    configurable: true,
  });

  const fetchMock = mock((...args: unknown[]) => {
    const url = String(args[0]);
    if (url.includes("api.github.com")) {
      return Promise.resolve(
        Response.json({
          tag_name: "v99.0.0",
          assets: [
            {
              name: assetName,
              browser_download_url: "https://example.com/loop-binary",
            },
          ],
        })
      );
    }
    return Promise.resolve(new Response("fake-binary-data"));
  });
  globalThis.fetch = fetchMock as typeof fetch;

  const errorMock = mock(() => undefined);
  console.log = mock(() => undefined);
  console.error = errorMock;

  try {
    const { handleManualUpdateCommand } = await import(
      `../../src/loop/update?nochecksum=${Date.now()}`
    );
    await handleManualUpdateCommand(["update"]);

    const errorCalls = errorMock.mock.calls.map((c) => String(c[0]));
    expect(
      errorCalls.some((msg) => msg.includes("no .sha256 checksum available"))
    ).toBe(true);
    expect(existsSync(STAGED_BINARY)).toBe(true);
  } finally {
    Object.defineProperty(process, "execPath", {
      value: originalExecPath,
      configurable: true,
    });
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    if (existsSync(STAGED_BINARY)) {
      unlinkSync(STAGED_BINARY);
    }
    if (existsSync(METADATA_FILE)) {
      unlinkSync(METADATA_FILE);
    }
  }
});
