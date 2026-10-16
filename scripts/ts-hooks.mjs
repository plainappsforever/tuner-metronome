// Lets plain Node (>= 22.15, type stripping) run the pure-TS engine from scripts: `node --import ./scripts/ts-hooks.mjs x.mjs`.
// Resolves extensionless relative imports to .ts and marks .ts files as ES modules. src/engine therefore uses only
// relative imports and erasable TypeScript syntax (no enums, namespaces or constructor parameter properties).
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw error;
    }
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' });
    return next(url, context);
  },
});
