import path from "node:path";
import { fileURLToPath } from "node:url";
import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const typedFiles = ["src/**/*.ts", "example/**/*.ts"];

export default tseslint.config(
    {
        ignores: ["dist/**", "node_modules/**", ".idea/**", ".eslintcache", "**/*.d.ts"],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked.map((config) => ({
        ...config,
        files: typedFiles,
        languageOptions: {
            ...config.languageOptions,
            parserOptions: {
                ...config.languageOptions?.parserOptions,
                projectService: true,
                tsconfigRootDir: __dirname,
            },
        },
    })),
    eslintConfigPrettier,
    {
        files: typedFiles,
        linterOptions: {
            reportUnusedDisableDirectives: "error",
        },
        rules: {
            "@typescript-eslint/consistent-type-imports": [
                "warn",
                {
                    prefer: "type-imports",
                    fixStyle: "inline-type-imports",
                },
            ],
            "@typescript-eslint/no-empty-function": "warn",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    args: "all",
                    argsIgnorePattern: "^_",
                    caughtErrors: "all",
                    caughtErrorsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                },
            ],
        },
    },
    {
        files: ["eslint.config.js"],
        languageOptions: {
            sourceType: "module",
        },
    },
);
