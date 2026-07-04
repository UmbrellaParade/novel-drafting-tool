import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#24211d",
        paper: "#fffdf8",
        mist: "#eef4f1",
        brass: "#b78442",
        rain: "#3a8278",
        plum: "#8b4d67",
        graphite: "#373737"
      },
      boxShadow: {
        page: "0 18px 45px rgba(36, 33, 29, 0.16)",
        panel: "0 10px 30px rgba(36, 33, 29, 0.08)"
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        serif: ["var(--font-serif)", "serif"]
      }
    }
  },
  plugins: []
};

export default config;
