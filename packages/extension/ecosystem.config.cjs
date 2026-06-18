// pm2 dev-process manager for this repo.
// Usage from the repo root:
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup   # (once, for boot-resume via systemd)
module.exports = {
	apps: [
		{
			name: 'pptx-dev-server',
			script: 'npm',
			args: 'run open-in-browser',
			autorestart: true,
			max_restarts: 10,
		},
		{
			name: 'pptx-watch',
			script: 'npm',
			args: 'run watch-web',
			autorestart: true,
			max_restarts: 10,
		},
	],
};
