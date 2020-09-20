/* eslint-disable @typescript-eslint/no-var-requires */
const { spawn, spawnSync } = require('child_process')
const gulp = require('gulp')
const watch = require('gulp-watch')

function clearDir() {
  spawnSync('rm', ['-rf', './build/src'])
}

function buildService() {
  spawn('tsc', ['-w'], { stdio: 'inherit', })
}

function buildView() {
  spawn('npx', [
    'webpack-dev-server', '--mode', 'development',
    '--port', '1080', '--hot'
  ], { stdio: 'inherit' })
}

function startApp() {
  let started = false
  return function () {
    if (!started) {
      started = true
      spawn('npx', [
        'electron', '--disable-gpu', 'build/src/main.js'
      ], { stdio: 'inherit' })
    }
  }
}

function dev() {
  clearDir()
  buildService()
  buildView()
  watch('./build', startApp())
}

gulp.task('dev', dev)
