import type { Config } from "tailwindcss";
import bimmerzPreset from "@emdzej/bimmerz-theme";

export default {
  content: [
    "./index.html",
    "./src/**/*.{ts,svelte}",
    "../../node_modules/@emdzej/ediabasx-web-ui/src/**/*.{ts,svelte}",
  ],
  presets: [bimmerzPreset],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: "rgb(var(--m-light) / <alpha-value>)",
          muted: "rgb(var(--m-dark) / <alpha-value>)",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
