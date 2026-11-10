// @vitest-environment node
import { describe, expect, it } from "vitest";
import { validateRefName } from "./refname";

describe("validateRefName", () => {
  it.each(["main", "feature/PAY-2318-refunds", "release/v1.2.0", "fix_login", "ünï/cødé", "a.b", "v1", "x@y"])("accepts %s", (n) => {
    expect(validateRefName(n)).toBeNull();
  });

  it.each([
    ["", "Enter a branch name."],
    ["my branch", "Branch names cannot contain spaces."],
    ["a\tb", "Branch names cannot contain spaces."],
    ["a\u0001b", "Branch names cannot contain control characters."],
    ["@", '"@" is not a valid branch name.'],
    ["HEAD", '"HEAD" is reserved. Pick another name.'],
    ["-x", 'Branch names cannot start with "-".'],
    ["/x", 'Branch names cannot start or end with "/".'],
    ["x/", 'Branch names cannot start or end with "/".'],
    ["a//b", 'Branch names cannot contain "//".'],
    ["a..b", 'Branch names cannot contain "..".'],
    ["a~1", 'Branch names cannot contain "~".'],
    ["a^", 'Branch names cannot contain "^".'],
    ["a:b", 'Branch names cannot contain ":".'],
    ["a?b", 'Branch names cannot contain "?".'],
    ["a*b", 'Branch names cannot contain "*".'],
    ["a[b", 'Branch names cannot contain "[".'],
    ["a\\b", 'Branch names cannot contain "\\".'],
    ["a@{b", 'Branch names cannot contain "@{".'],
    ["a.", 'Branch names cannot end with ".".'],
    [".a", 'Each part of a branch name must not start with ".".'],
    ["x/.a", 'Each part of a branch name must not start with ".".'],
    ["a.lock", 'Each part of a branch name must not end with ".lock".'],
    ["x.lock/y", 'Each part of a branch name must not end with ".lock".'],
  ])("rejects %j", (name, message) => {
    expect(validateRefName(name)).toBe(message);
  });

  it("words the message for tags and allows HEAD-like tag names", () => {
    expect(validateRefName("v 1", "tag")).toBe("Tag names cannot contain spaces.");
    expect(validateRefName("", "tag")).toBe("Enter a tag name.");
    expect(validateRefName("HEAD", "tag")).toBeNull();
  });
});
