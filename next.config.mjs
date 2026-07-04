import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

const repoName = "novel-drafting-tool";

/** @type {import('next').NextConfig} */
const nextConfig = (phase) => {
  const isGitHubPagesBuild = phase !== PHASE_DEVELOPMENT_SERVER;

  return {
    output: "export",
    basePath: isGitHubPagesBuild ? `/${repoName}` : "",
    assetPrefix: isGitHubPagesBuild ? `/${repoName}/` : "",
    images: {
      unoptimized: true
    }
  };
};

export default nextConfig;
