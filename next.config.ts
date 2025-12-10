import path from "path";
import { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack(config) {
    config.resolve.alias["@"] = path.resolve(__dirname, "src");  // ← add this line
    return config;
  },
};
export default nextConfig;
