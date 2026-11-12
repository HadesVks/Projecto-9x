module.exports = {
  apps: [
    {
      name: 'projecto-9x',
      script: 'server.js',
      cwd: '/home/hades/Proyectos/Projecto-9x',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 9090
      }
    }
  ]
};
