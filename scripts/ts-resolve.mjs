// Lets `node scripts/*.ts` run library code that uses bundler-style
// extensionless relative imports (which is what Next.js expects in app code).
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

export function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const isAliased = specifier.startsWith("@/");

  if (isRelative || isAliased) {
    const hasExtension = /\.[cm]?[jt]sx?$/.test(specifier);
    if (!hasExtension) {
      const base = isAliased
        ? resolvePath(process.cwd(), specifier.slice(2))
        : resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);

      for (const candidate of [
        `${base}.ts`,
        `${base}.tsx`,
        `${base}/index.ts`,
        `${base}.js`,
      ]) {
        if (existsSync(candidate)) {
          return nextResolve(pathToFileURL(candidate).href, context);
        }
      }
    } else if (isAliased) {
      const absolute = resolvePath(process.cwd(), specifier.slice(2));
      if (existsSync(absolute)) {
        return nextResolve(pathToFileURL(absolute).href, context);
      }
    }
  }

  return nextResolve(specifier, context);
}
