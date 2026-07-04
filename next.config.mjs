const repoName = "novel-drafting-tool";
const isProductionBuild = process.env.NODE_ENV === "production";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  basePath: isProductionBuild ? `/${repoName}` : "",
  assetPrefix: isProductionBuild ? `/${repoName}/` : "",
  images: {
    unoptimized: true
  }
};

export default nextConfig;
