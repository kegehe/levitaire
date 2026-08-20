import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "src-tauri/"],
  },
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    rules: {
      // 允许 console（桌面应用中合理使用）
      "no-console": "off",
      // 允许空函数（React 组件常见占位）
      "no-empty": ["error", { allowEmptyCatch: true }],
      // 未使用变量：下划线前缀忽略（catch 子句占位等）
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
);
