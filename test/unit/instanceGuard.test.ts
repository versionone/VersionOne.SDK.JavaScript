import { describe, expect, it } from "vitest";
import { apiTestInstances, permitted } from "../integration/instanceGuard";

// The integration tier writes fixtures; where it may do so is decided here, with no instance named in the tree.
describe("integration instance guard", () => {
  it("reads the allowed hosted instances from SDK_TEST_ALLOWED_INSTANCES, trimmed, lower-cased, without trailing slashes", () => {
    expect(apiTestInstances({})).toEqual([]);
    expect(apiTestInstances({ SDK_TEST_ALLOWED_INSTANCES: " https://wwwN.v1host.com/ApiTesting/ ,https://wwwN.v1host.com/Other" })).toEqual(["https://wwwn.v1host.com/apitesting", "https://wwwn.v1host.com/other"]);
  });

  it("permits a local instance always, a hosted one only when allowed, and V1Production never", () => {
    const allowed = apiTestInstances({ SDK_TEST_ALLOWED_INSTANCES: "https://wwwN.v1host.com/ApiTesting" });
    expect(permitted("http://localhost/VersionOne.Web", [])).toBe(true);
    expect(permitted("https://wwwN.v1host.com/ApiTesting/", allowed)).toBe(true);
    expect(permitted("https://wwwN.v1host.com/ApiTesting", [])).toBe(false);
    expect(permitted("https://wwwN.v1host.com/Customer", allowed)).toBe(false);
    expect(permitted("https://wwwN.v1host.com/V1Production", ["https://wwwn.v1host.com/v1production"])).toBe(false);
    expect(permitted("http://localhost/V1Production", [])).toBe(false);
  });
});
