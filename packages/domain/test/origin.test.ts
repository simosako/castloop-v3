import { expect, test } from "bun:test";
import { configuredHttpsOrigin } from "../src/origin";

test("normalizes configured HTTPS origins without accepting other URLs", () => {
  expect(configuredHttpsOrigin("https://PODCAST.example:443/")).toBe("https://podcast.example");
  expect(configuredHttpsOrigin("https://podcast.example:8443")).toBe("https://podcast.example:8443");
  for (const value of ["", "http://podcast.example", "https://user:secret@podcast.example/", "https://podcast.example/path", "https://podcast.example/?query=1", "https://podcast.example/#fragment"]) {
    expect(configuredHttpsOrigin(value)).toBeNull();
  }
});
