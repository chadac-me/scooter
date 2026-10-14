/**
 * Images pasted through SimpleImageAttachmentAdapter reach the agent: the client
 * converts the blob: URL to base64 data, POSTs it as an image content block, and
 * normalizeContent on the server turns that into the { data, mimeType } the bridge
 * sends on as an ACP image block.
 */

import { describe, it, expect } from "vitest";
import { normalizeContent } from "../../src/agui/server.js";

describe("blob URL flow (client → server → agent)", () => {
  it("server accepts base64 image data from client blob URL conversion", () => {
    // What the client sends to /agui after converting the blob: URL.
    const clientMessage = {
      role: "user",
      content: [
        { type: "text", text: "Here's a screenshot" },
        { 
          type: "image", 
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png"
        },
      ],
    };

    const { text, images } = normalizeContent(clientMessage.content);
    
    expect(text).toBe("Here's a screenshot");
    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      mimeType: "image/png",
    });
  });

  it("server accepts multiple images from blob URL conversions", () => {
    const clientMessage = {
      role: "user",
      content: [
        { type: "image", data: "QUJD", mimeType: "image/png" },
        { type: "text", text: "Compare these" },
        { type: "image", data: "REVG", mimeType: "image/jpeg" },
      ],
    };

    const { text, images } = normalizeContent(clientMessage.content);
    
    expect(text).toBe("Compare these");
    expect(images).toHaveLength(2);
    expect(images[0]).toEqual({ data: "QUJD", mimeType: "image/png" });
    expect(images[1]).toEqual({ data: "REVG", mimeType: "image/jpeg" });
  });

  it("regression: blob URLs were silently skipped before fix", () => {
    // A raw blob: URL is not a data: URL, so the server skips it.
    const preFix = {
      role: "user",
      content: [
        { type: "text", text: "Look at this" },
        { type: "image", image: "blob:http://localhost/abc-123" },
      ],
    };

    const { text, images } = normalizeContent(preFix.content);
    
    expect(text).toBe("Look at this");
    expect(images).toEqual([]);
  });

  it("server still accepts data: URLs from assistant-ui (backward compat)", () => {
    // assistant-ui sends { type: "image", image: "data:..." }.
    const assistantUiMessage = {
      role: "user",
      content: [
        { type: "image", image: "data:image/png;base64,QUJD" },
      ],
    };

    const { images } = normalizeContent(assistantUiMessage.content);
    
    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({ data: "QUJD", mimeType: "image/png" });
  });

  it("image-only message (no text) is valid", () => {
    const imageOnly = {
      role: "user",
      content: [
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ],
    };

    const { text, images } = normalizeContent(imageOnly.content);
    
    expect(text).toBe("");
    expect(images).toHaveLength(1);
  });

  it("handles the SimpleImageAttachmentAdapter paste scenario", () => {
    // The message as the server receives it after the client's imagesFromContent() conversion.
    const afterClientConversion = {
      role: "user",
      content: [
        { type: "text", text: "Screenshot of the error" },
        { 
          type: "image",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png"
        },
      ],
    };

    const { text, images } = normalizeContent(afterClientConversion.content);
    
    expect(text).toBe("Screenshot of the error");
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe("image/png");
    expect(images[0].data).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});
