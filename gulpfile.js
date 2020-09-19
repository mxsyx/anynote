/* eslint-disable @typescript-eslint/no-var-requires */
const gulp = require('gulp')
const { spawn, spawnSync } = require('child_process')

let elPid
function rebuildService() {
  const ptsc = spawnSync('tsc', { stdio: 'inherit' })

  if (ptsc.status === 0) {
    if (elPid) {  // kill previous electron process
      process.kill(elPid)
    } 

    const pelectron = spawnSync('npx', [
      'electron', '--disable-gpu', 'build/src/main.js'
    ], { stdio: 'inherit' })
    if (pelectron.status === 0) {
      elPid = pelectron.pid
      return Promise.resolve()
    }
  }
}

function dev() {
  spawn('npx', [
    'webpack-dev-server', '--mode', 'development',
    '--port', '1080', '--hot'
  ], { stdio: 'inherit' })
  rebuildService()
}

gulp.task('dev', dev)

gulp.watch('src/service', rebuildService)
