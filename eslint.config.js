import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["dist/**", "node_modules/**", "testing/**", "test/*.js", "test/*.mjs"],
    },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                project: ["./tsconfig.eslint.json"],
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "no-restricted-globals": [
                "error",
                { name: "Buffer", message: "Use Uint8Array. Buffer is not allowed above the transport layer." },
            ],
            "no-restricted-imports": [
                "error",
                {
                    paths: [
                        { name: "buffer", message: "Use Uint8Array. Buffer is not allowed above the transport layer." },
                    ],
                },
            ],
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
        },
    },
    {
        files: ["src/transports/**/*.ts"],
        rules: {
            "no-restricted-globals": "off",
            "no-restricted-imports": "off",
        },
    },
    {
        files: ["**/*.js", "**/*.mjs"],
        extends: [tseslint.configs.disableTypeChecked],
    },
);
