export default [
  {
    ignores: ["dist/**", "public/vendor/**"]
  },
  {
    files: ["src/**/*.js", "scripts/**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        Vue: "readonly",
        ElementPlus: "readonly",
        LXM_CONFIG: "readonly",
        LXM_DATA: "readonly",
        LXMFormat: "readonly",
        LXM_SERVICE: "readonly",
        require: "readonly",
        module: "readonly",
        process: "readonly",
        console: "readonly"
      }
    },
    rules: {
      "no-unused-vars": "off",
      "no-undef": "warn",
      "no-console": "off"
    }
  }
];
