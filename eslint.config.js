import tseslint from "typescript-eslint";

// Syntax-level recommended rules for every TS/JS file, plus the type-aware
// rules for the shipped code (index.ts and lib/). Tests stay on the syntactic
// set so node:test's promise-returning describe/it don't drown the signal.
export default tseslint.config(
  {
    ignores: ["node_modules/**", "package-lock.json"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["index.ts", "lib/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
