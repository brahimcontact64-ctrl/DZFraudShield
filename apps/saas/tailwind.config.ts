import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#0B3D2E",
          soft: "#155E47",
          accent: "#D6A74C"
        },
        surface: "#F4F6F5",
        sidebar: {
          bg: "#0F1B14",
          hover: "#172A21",
          active: "#1E3329",
          border: "#1E3329",
          text: "#8BAA97",
          "text-active": "#FFFFFF"
        }
      },
      boxShadow: {
        card: "0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)",
        "card-hover": "0 4px 16px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)",
        modal: "0 20px 60px rgba(0,0,0,0.15), 0 4px 16px rgba(0,0,0,0.08)"
      },
      borderRadius: {
        xl2: "1rem",
        xl3: "1.25rem"
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"]
      }
    }
  },
  plugins: []
};

export default config;
