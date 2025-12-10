import path from "path";
import { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  basePath: "/hex-map-editor",
  images: {
    unoptimized: true,
  },
  webpack(config) {
    config.resolve.alias["@"] = path.resolve(__dirname, "src");
    return config;
  },
};
export default nextConfig;
