const gulp = require('gulp')
const { spawnSync } = require('child_process')

function rebuildService() {
  const process = spawnSync('tsc', ['-p', 'src/service'])
  return Promise.resolve()
}

gulp.task('rebuild', rebuildService)

gulp.watch('src/service', rebuildService)
