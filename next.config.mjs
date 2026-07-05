import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

const repoName = "novel-drafting-tool";

/** @type {import('next').NextConfig} */
const nextConfig = (phase) => {
  const isGitHubPagesBuild = phase !== PHASE_DEVELOPMENT_SERVER;

  return {
    output: "export",
    basePath: isGitHubPagesBuild ? `/${repoName}` : "",
    assetPrefix: isGitHubPagesBuild ? `/${repoName}/` : "",
    generateBuildId: async () => {
      const source = process.env.GITHUB_SHA ?? Date.now().toString(36);
      const safeSource = source.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
      return `build-${safeSource || "local"}`;
    },
    images: {
      unoptimized: true
    }
  };
};

export default nextConfig;
