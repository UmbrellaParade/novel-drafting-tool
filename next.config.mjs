const repoName = "novel-drafting-tool";
const isGitHubActions = process.env.GITHUB_ACTIONS === "true";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  basePath: isGitHubActions ? `/${repoName}` : "",
  assetPrefix: isGitHubActions ? `/${repoName}/` : "",
  images: {
    unoptimized: true
  }
};

export default nextConfig;
