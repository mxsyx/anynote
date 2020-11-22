/**
 * AnyNote
 * Mxsyx (mxsyxin@gmail.com)
 * Front-end Automation.
 */
const readline = require('readline')
const { spawn, spawnSync } = require('child_process')
const gulp = require('gulp')
const watch = require('gulp-watch')

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

const symbols = {
  F: '🐞',   // fix bug
  D: '✨',  // in development
  A: '💪',  // finish new feature
  R: '✂️',  // delete something
  B: '🔔',  // build project
  P: '🎖',   // release or online
  U: '📅',  // update docs
}

function clearDir() {
  spawnSync('rm', ['-rf', './build/src'])
}

function getCurrentBranchName() {
  return new Promise((resolve, reject) => {
    const pipe = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe' })
    const name = String(pipe.stdout).trim()
    name ? resolve(name) : reject()
  })
}

function reStartApp() {
  let prevTime = Date.now()
  let proc = null
  return function () {
    if (Date.now() - prevTime > 1000) {
      prevTime = Date.now()
      proc && proc.kill()
      proc =  spawn('npx', ['electron', '--disable-gpu', 'build/src/main.js'], { stdio: 'inherit' })
      console.log(`[Info: restarted electron app / PID: ${proc.pid}]`);
    }
  }
}

function dev() {
  clearDir()
  spawn('tsc', ['-w'], { stdio: 'inherit' })
  spawn('npx', [ 'webpack-dev-server', '--mode', 'development', '--port', '8187', '--hot'], { stdio: 'inherit' })
  watch('./build', reStartApp())
}

function commit() {
  return new Promise(async resolve => {
    const branch = await getCurrentBranchName()
    rl.question(`\nCurrent branch: \x1B[36m${branch}\x1B[0m, are you sure to commit? (y/n) `, (msg) => {
      if (msg !== 'y') { resolve(); return }
      console.info('\n', JSON.stringify(symbols))
      rl.question('please input your commit message: ', (msg) => {
        spawnSync('git', ['add', '.'])
        const symbol = symbols[msg[0]] ? symbols[msg[0]] : '😘'
        msg = symbol + msg.substr(1)
        spawnSync('git', ['commit', '-m', msg], { stdio: 'inherit' })
        rl.close()
        resolve()
      })
    })
  })
}

gulp.task('dev', dev, () => {
  console.log('Task completed.')
})
gulp.task('commit', commit, () => {
  console.log('Task completed.')
})
