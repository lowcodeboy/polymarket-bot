module.exports = {
  apps: [
    {
      name: "polymarket-copy-bot",
      script: "dist/index.js",
      restart_delay: 5000,
      max_restarts: 50,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
