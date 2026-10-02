import { describe, expect, it } from "vitest";
import { classifyUpload, sanitizeFilename, storageName } from "../media/formats";
import { looksLikeMarkup, sniffMedia } from "../media/sniff";
import { assertSafeKey, verifyFileSignature } from "../storage/local";
import { LocalStorageDriver } from "../storage/local";
import { isPrivateAddress, safeFetch } from "./safe-fetch";

describe("SSRF guard", () => {
  it("blocks private, loopback, link-local and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.2.3.4", "172.16.0.1", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "104.16.0.1", "2606:4700::6810:84e5"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("sees through IPv4 hidden in IPv6, tunnels and odd spellings", () => {
    for (const ip of [
      "::ffff:7f00:1", // 127.0.0.1, hex form
      "::ffff:a9fe:a9fe", // 169.254.169.254
      "0:0:0:0:0:ffff:10.0.0.1",
      "::127.0.0.1", // IPv4-compatible
      "64:ff9b::a9fe:a9fe", // NAT64 → metadata
      "2002:c0a8:0101::1", // 6to4 → 192.168.1.1
      "2001:0:4136:e378:8000:63bf:3fff:fdd2", // Teredo
      "fec0::1",
      "2001:db8::1",
      "[::1]",
      "not-an-ip",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("::ffff:808:808")).toBe(false); // 8.8.8.8
    expect(isPrivateAddress("2002:0808:0808::1")).toBe(false);
  });

  it("refuses literal private IPs in URLs before connecting (no DNS lookup happens for them)", async () => {
    for (const url of ["http://127.0.0.1/a.png", "http://169.254.169.254/latest/meta-data/", "http://[::ffff:7f00:1]/", "http://[::1]:8080/x"]) {
      await expect(safeFetch(url, { maxBytes: 1000, timeoutMs: 500 }), url).rejects.toThrow(/isn't allowed/);
    }
  });
});

describe("upload classification & sniffing", () => {
  it("classifies by type and extension, refusing executables and treating SVG as a file", () => {
    expect(classifyUpload("render.PNG", "")).toEqual({ kind: "IMAGE", mimeType: "image/png" });
    expect(classifyUpload("clip.mov", "video/quicktime")).toEqual({ kind: "VIDEO", mimeType: "video/quicktime" });
    expect(classifyUpload("logo.svg", "image/svg+xml")).toEqual({ kind: "FILE", mimeType: "image/svg+xml" });
    expect(classifyUpload("setup.exe", "application/octet-stream")).toHaveProperty("error");
    expect(classifyUpload("script.ps1", "text/plain")).toHaveProperty("error");
  });

  it("identifies media by magic bytes", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(8)]);
    const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  "), Buffer.alloc(8)]);
    expect(sniffMedia(png)).toEqual({ kind: "IMAGE", mimeType: "image/png" });
    expect(sniffMedia(jpeg)).toEqual({ kind: "IMAGE", mimeType: "image/jpeg" });
    expect(sniffMedia(mp4)).toEqual({ kind: "VIDEO", mimeType: "video/mp4" });
    expect(sniffMedia(mov)).toEqual({ kind: "VIDEO", mimeType: "video/quicktime" });
    expect(sniffMedia(Buffer.from("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(looksLikeMarkup(Buffer.from("  <!DOCTYPE html><p>"))).toBe(true);
  });

  it("sanitises filenames and storage keys", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename('bad<name>:"?.png')).toBe("badname.png");
    expect(storageName("Gojo Hollow Purple (final) v2.mp4")).toBe("Gojo-Hollow-Purple-final-v2.mp4");
    expect(() => assertSafeKey("studios/../../secret")).toThrow();
    expect(() => new LocalStorageDriver(".data/x").resolve("a/../../b")).toThrow();
  });

  it("binds S3 upload links to the announced size (the bucket refuses any other body)", async () => {
    const { S3StorageDriver } = await import("../storage/s3");
    const driver = new S3StorageDriver({ bucket: "forge-test", region: "auto", endpoint: "https://example.invalid", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", forcePathStyle: true });
    const target = await driver.createUploadTarget("studios/a/original.png", { contentType: "image/png", size: 1234 });
    const signed = new URL(target.url).searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signed.split(";")).toEqual(expect.arrayContaining(["content-length", "content-type", "host"]));
  });

  it("rejects tampered or expired file signatures", () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    expect(verifyFileSignature("studios/a/file.png", future, "", "forged")).toBe(false);
    expect(verifyFileSignature("studios/a/file.png", Math.floor(Date.now() / 1000) - 10, "", "whatever")).toBe(false);
  });
});
