import { afterEach, describe, expect, test } from "bun:test";
import { eigenweltCallbackPlatform, eigenweltConnectionPlatformUrl, validateEigenweltPlatformUrl } from "./eigenwelt-endpoints.js";

const previous = process.env.EIGENWELT_PLATFORM_URL;
const previousDevMode = process.env.LEGALWORK_DEV_MODE;
const previousRegionalDevelopment = process.env.LEGALWORK_DEV_REGIONAL_ROUTING;
afterEach(() => { if (previous === undefined) delete process.env.EIGENWELT_PLATFORM_URL; else process.env.EIGENWELT_PLATFORM_URL = previous; });
afterEach(() => {
  if (previousDevMode === undefined) delete process.env.LEGALWORK_DEV_MODE;
  else process.env.LEGALWORK_DEV_MODE = previousDevMode;
  if (previousRegionalDevelopment === undefined) delete process.env.LEGALWORK_DEV_REGIONAL_ROUTING;
  else process.env.LEGALWORK_DEV_REGIONAL_ROUTING = previousRegionalDevelopment;
});
describe("regional Eigenwelt routing", () => {
  test("keeps EU and US account requests on their saved deployment", () => {
    delete process.env.EIGENWELT_PLATFORM_URL;
    for (const region of ["eu", "us"]) {
      const platformURL = `https://${region}.platform.eigenweltlabs.com`;
      expect(eigenweltConnectionPlatformUrl({ platformURL })).toBe(platformURL);
      expect(eigenweltCallbackPlatform("unpredictable-state", `unpredictable-state.${region}`)).toBe(platformURL);
    }
    expect(eigenweltCallbackPlatform("state", "state")).toBe("https://platform.eigenweltlabs.com");
  });
  test("rejects forged states and arbitrary callback destinations", () => {
    delete process.env.EIGENWELT_PLATFORM_URL;
    for (const state of [null, "foreign.eu", "state.europe", "state.eu.attacker", "state.https://attacker.example"]) {
      expect(eigenweltCallbackPlatform("state", state)).toBeNull();
    }
    for (const url of ["http://eu.platform.eigenweltlabs.com", "https://eu.platform.eigenweltlabs.com.attacker.example", "https://user@eu.platform.eigenweltlabs.com", "https://eu.platform.eigenweltlabs.com/path", "https://eu.platform.eigenweltlabs.com?token=x", "https://eu.platform.eigenweltlabs.com#x"]) {
      expect(() => validateEigenweltPlatformUrl(url)).toThrow();
    }
  });
  test("an explicitly pinned EU installation accepts only its own regional callback", () => {
    process.env.EIGENWELT_PLATFORM_URL = "https://eu.platform.eigenweltlabs.com";
    expect(eigenweltCallbackPlatform("state", "state.eu")).toBe("https://eu.platform.eigenweltlabs.com");
    expect(eigenweltCallbackPlatform("state", "state.us")).toBeNull();
  });
  test("explicit custom installations stay isolated from production regions", () => {
    process.env.EIGENWELT_PLATFORM_URL = "http://127.0.0.1:9876";
    expect(validateEigenweltPlatformUrl("http://127.0.0.1:9876/")).toBe("http://127.0.0.1:9876");
    expect(eigenweltCallbackPlatform("state", "state.eu")).toBeNull();
    expect(() => eigenweltConnectionPlatformUrl({ platformURL: "https://eu.platform.eigenweltlabs.com" })).toThrow();
  });
  test("the isolated regional dev client discovers either region without accepting production or custom hosts", () => {
    process.env.LEGALWORK_DEV_MODE = "1";
    process.env.LEGALWORK_DEV_REGIONAL_ROUTING = "1";
    process.env.EIGENWELT_PLATFORM_URL = "https://eu.platform.eigenweltlabs.com";
    expect(eigenweltCallbackPlatform("state", "state.us")).toBe("https://us.platform.eigenweltlabs.com");
    expect(() => validateEigenweltPlatformUrl("https://platform.eigenweltlabs.com")).toThrow();
    expect(() => validateEigenweltPlatformUrl("https://attacker.example")).toThrow();
    process.env.LEGALWORK_DEV_MODE = "0";
    expect(eigenweltCallbackPlatform("state", "state.us")).toBeNull();
    process.env.LEGALWORK_DEV_MODE = "1";
    process.env.EIGENWELT_PLATFORM_URL = "http://127.0.0.1:9876";
    expect(eigenweltCallbackPlatform("state", "state.eu")).toBeNull();
  });
});
