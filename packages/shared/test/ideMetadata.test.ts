import { describe, expect, it } from "vitest";
import {
  extractOpenedFilePath,
  getFilename,
  isIdeMetadata,
  parseOpenedFiles,
  stripIdeMetadata,
} from "../src/ideMetadata.js";

describe("ideMetadata", () => {
  describe("isIdeMetadata", () => {
    it("detects ide_opened_file tags", () => {
      expect(
        isIdeMetadata(
          "<ide_opened_file>The user opened the file /path/to/file.ts in the IDE.</ide_opened_file>",
        ),
      ).toBe(true);
    });

    it("detects ide_selection tags", () => {
      expect(
        isIdeMetadata(
          "<ide_selection>The user selected lines 1-10 from /path/to/file.ts</ide_selection>",
        ),
      ).toBe(true);
    });

    it("detects tags with leading whitespace", () => {
      expect(
        isIdeMetadata(
          "  <ide_opened_file>The user opened the file /path/to/file.ts in the IDE.</ide_opened_file>",
        ),
      ).toBe(true);
    });

    it("returns false for regular text", () => {
      expect(isIdeMetadata("Hello, how can I help you?")).toBe(false);
    });

    it("returns false for text containing but not starting with tag", () => {
      expect(
        isIdeMetadata("Please look at <ide_opened_file>file</ide_opened_file>"),
      ).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isIdeMetadata("")).toBe(false);
    });
  });

  describe("stripIdeMetadata", () => {
    it("removes ide_opened_file tags", () => {
      const input =
        "<ide_opened_file>The user opened the file /path/to/file.ts in the IDE.</ide_opened_file>Hello world";
      expect(stripIdeMetadata(input)).toBe("Hello world");
    });

    it("removes ide_selection tags", () => {
      const input =
        "<ide_selection>The user selected lines 1-10</ide_selection>What does this do?";
      expect(stripIdeMetadata(input)).toBe("What does this do?");
    });

    it("removes multiple tags", () => {
      const input =
        "<ide_opened_file>file1</ide_opened_file><ide_opened_file>file2</ide_opened_file>Question here";
      expect(stripIdeMetadata(input)).toBe("Question here");
    });

    it("removes mixed tag types", () => {
      const input =
        "<ide_opened_file>file</ide_opened_file><ide_selection>code</ide_selection>Help me";
      expect(stripIdeMetadata(input)).toBe("Help me");
    });

    it("preserves content without tags", () => {
      const input = "Just a regular message with no tags";
      expect(stripIdeMetadata(input)).toBe(
        "Just a regular message with no tags",
      );
    });

    it("handles multiline tag content", () => {
      const input = `<ide_selection>The user selected lines 1-5:
function foo() {
  return bar;
}
</ide_selection>What does this function do?`;
      expect(stripIdeMetadata(input)).toBe("What does this function do?");
    });

    it("handles empty input", () => {
      expect(stripIdeMetadata("")).toBe("");
    });

    it("handles input with only tags", () => {
      expect(stripIdeMetadata("<ide_opened_file>file</ide_opened_file>")).toBe(
        "",
      );
    });
  });

  describe("extractOpenedFilePath", () => {
    it("extracts file path from standard format", () => {
      const content =
        "The user opened the file /Users/test/project/src/index.ts in the IDE. This may or may not be related.";
      expect(extractOpenedFilePath(content)).toBe(
        "/Users/test/project/src/index.ts",
      );
    });

    it("extracts file path from alternate format", () => {
      const content = "opened the file /path/to/file.ts in the IDE";
      expect(extractOpenedFilePath(content)).toBe("/path/to/file.ts");
    });

    it("returns null for unrecognized format", () => {
      expect(extractOpenedFilePath("random content")).toBeNull();
    });

    it("handles paths with spaces", () => {
      const content =
        "The user opened the file /Users/test/My Project/file.ts in the IDE.";
      expect(extractOpenedFilePath(content)).toBe(
        "/Users/test/My Project/file.ts",
      );
    });
  });

  describe("parseOpenedFiles", () => {
    it("extracts single file path", () => {
      const content =
        "<ide_opened_file>The user opened the file /path/to/file.ts in the IDE.</ide_opened_file>Question";
      expect(parseOpenedFiles(content)).toEqual(["/path/to/file.ts"]);
    });

    it("extracts multiple file paths", () => {
      const content =
        "<ide_opened_file>The user opened the file /path/a.ts in the IDE.</ide_opened_file>" +
        "<ide_opened_file>The user opened the file /path/b.ts in the IDE.</ide_opened_file>Question";
      expect(parseOpenedFiles(content)).toEqual(["/path/a.ts", "/path/b.ts"]);
    });

    it("returns empty array for no tags", () => {
      expect(parseOpenedFiles("Just regular text")).toEqual([]);
    });

    it("skips tags with unrecognized content format", () => {
      const content =
        "<ide_opened_file>some random content</ide_opened_file>Question";
      expect(parseOpenedFiles(content)).toEqual([]);
    });
  });

  describe("getFilename", () => {
    it("extracts filename from path", () => {
      expect(getFilename("/Users/test/project/src/index.ts")).toBe("index.ts");
    });

    it("handles single filename", () => {
      expect(getFilename("file.ts")).toBe("file.ts");
    });

    it("handles path ending with slash", () => {
      // Returns original path for trailing slash (edge case, fallback behavior)
      expect(getFilename("/path/to/dir/")).toBe("/path/to/dir/");
    });

    it("handles Windows-style paths with forward slashes", () => {
      expect(getFilename("C:/Users/test/file.ts")).toBe("file.ts");
    });
  });
});
