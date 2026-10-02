import os from "node:os";
import path from "node:path";

/**
 * Joins paths that only exist at runtime (temp dirs, scratch files). Deliberately not
 * `path.join(dir, "file.ext")`: the bundler's file tracing reads that as "some file.ext inside
 * the project" and walks the whole project directory looking for matches.
 */
export function runtimePath(...parts: string[]): string {
  return path.normalize(parts.join(path.sep));
}

/** Prefix for `fs.mkdtemp` inside the OS temp directory. */
export function tempPrefix(name: string): string {
  return runtimePath(os.tmpdir(), name);
}
