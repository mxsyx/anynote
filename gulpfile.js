/* eslint-disable @typescript-eslint/no-var-requires */
const gulp = require('gulp')
const { spawn, spawnSync } = require('child_process')

let elPid
function rebuildService() {
  const ptsc = spawnSync('tsc', ['-p', 'tsconfig.service.json'], { stdio: 'inherit' })

  if (ptsc.status === 0) {
    if (elPid) {  // kill previous electron process
      process.kill(elPid)
    }
    
    const pelectron = spawnSync('npx', ['electron', '--disable-gpu', 'src/desktop/main.js'], {stdio:'inherit'})
    if (pelectron.status === 0) {
      elPid = pelectron.pid
      return Promise.resolve()
    }
  }
}

function dev() {
  const pview = spawn('npx', [
    'webpack-dev-server', '--mode', 'development',
    '--port', '20719', '--hot'
  ], { stdio: 'inherit' })
  rebuildService()
}

gulp.task('dev', dev)

gulp.watch('src/service', rebuildService)
